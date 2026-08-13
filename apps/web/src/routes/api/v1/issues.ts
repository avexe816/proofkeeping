/**
 * 設備不具合の API（PK-SPEC-P2 §14.3）。
 *
 * ```
 * POST   /api/v1/issues
 * GET    /api/v1/issues?propertyId=&status=&severity=
 * GET    /api/v1/issues/:id
 * PATCH  /api/v1/issues/:id/status
 * POST   /api/v1/issues/:id/resolve
 * ```
 *
 * task: docs/tasks/P2-12.md
 *
 * ── `resolve` を `status` と別に置いてある ──────────────
 * §14.3 が両方を挙げている。中身は `PATCH /status` に `to: "RESOLVED"` を
 * 送るのと同じで、**解決内容を必須にする点だけが違う**（DECISIONS #081）。
 * 経路を分けてあるのは、現場・運営の画面が「解決」を 1 つの操作として
 * 扱えるようにするため。**判定は同じ関数を通る。**
 *
 * ── 写真は 4 経路で同じ手順を通る ───────────────────────
 * `POST /:id/photos` は `multipart/form-data`。EXIF 除去・ハッシュ・R2 は
 * `lib/photo/pipeline.ts`（P2-13 が抽出 / OPEN_QUESTIONS #051 の回答）。
 * **閉じた報告には足せない**（後から証跡を足せる形にしない）。
 */

import {
  issueCreateRequestSchema,
  issueStatusRequestSchema,
  type IssueError,
  type IssueReportSummary,
  type PhotoError,
} from "@pk/contracts";
import {
  findIssueReportById,
  findRoomById,
  listIssueHistory,
  listIssuePhotos,
  type IssueReportFilter,
  type IssueSeverity,
  type IssueStatus,
} from "@pk/db";
import { Hono, type Context } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import {
  changeIssueStatus,
  listVisibleIssues,
  reportIssue,
  toIssueSummary,
} from "../../../lib/report/issue.js";
import { uploadIssuePhoto } from "../../../lib/photo/reportUpload.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getNow, getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const issues = new Hono<AppEnv>();

function invalidRequest(): IssueError {
  return { error: "INVALID_REQUEST" };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 一覧（§8）。**`CLEANER` は自分が報告したものだけ**（`listVisibleIssues()`）。 */
issues.get("/", async (c) => {
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "issue.read", propertyTarget([propertyId]));

  const statusParam = c.req.query("status");
  const severityParam = c.req.query("severity");
  const filter: IssueReportFilter = {
    propertyId,
    ...(c.req.query("roomId") === undefined ? {} : { roomId: c.req.query("roomId") }),
    ...(statusParam === undefined
      ? {}
      : { status: statusParam.split(",") as readonly IssueStatus[] }),
    ...(severityParam === undefined
      ? {}
      : { severity: severityParam.split(",") as readonly IssueSeverity[] }),
  };

  const data = await listVisibleIssues(c.env, ctx, getSession(c).membershipId, filter);
  return c.json({ data });
});

/** 1 件（§8）。 */
issues.get("/:issueId", async (c) => {
  const ctx = getTenant(c);
  const row = await findIssueReportById(c.env, ctx, c.req.param("issueId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "issue.read", propertyTarget([row.propertyId]));

  // §8 に「自分の報告だけ」の明記は無いが、一覧が `CLEANER` を絞る以上、
  // 1 件取得だけ開けておくと絞りが意味を失う。**404 で揃える**（INV-31）。
  if (ctx.role === "CLEANER" && row.reportedById !== getSession(c).membershipId) {
    return c.notFound();
  }

  const body: { data: IssueReportSummary; history: unknown } = {
    data: toIssueSummary(row),
    history: await listIssueHistory(c.env, ctx, row.id),
  };
  return c.json(body);
});

/**
 * 報告（§8.1）。
 *
 * **施設は客室から解決する**（INV-32）。`CRITICAL` は `confirmed: true` が
 * 無ければ 409（§8.2 MUST の①）。
 */
issues.post("/", async (c) => {
  const parsed = issueCreateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const room = await findRoomById(c.env, ctx, parsed.data.roomId);
  if (room === undefined) return c.notFound();
  assertPermission(ctx, "issue.write", propertyTarget([room.propertyId]));

  const outcome = await reportIssue(c.env, ctx, {
    propertyId: room.propertyId,
    roomId: room.id,
    taskId: parsed.data.taskId ?? null,
    category: parsed.data.category,
    severity: parsed.data.severity,
    title: parsed.data.title,
    description: parsed.data.description,
    reportedById: getSession(c).membershipId,
    confirmed: parsed.data.confirmed ?? false,
    ...(c.req.header("CF-Connecting-IP") === undefined
      ? {}
      : { ip: c.req.header("CF-Connecting-IP") }),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies IssueError, 409);
  }
  return c.json({ issueId: outcome.issueId, roomBlocked: outcome.roomBlocked }, 201);
});

/** 状態の更新（§8.3）。**客室に触らない。** */
issues.patch("/:issueId/status", (c) => runStatusChange(c, c.req.param("issueId"), null));

/**
 * 解決（§8.3）。**`PATCH /status` の `to: "RESOLVED"` と同じ判定を通る。**
 *
 * `resolutionNote` が無ければ `RESOLUTION_NOTE_REQUIRED`（DECISIONS #081）。
 */
issues.post("/:issueId/resolve", (c) => runStatusChange(c, c.req.param("issueId"), "RESOLVED"));

/**
 * 状態変更の共通処理。
 *
 * `issueId` を引数で受けているのは、`Context<AppEnv>`（経路の型を持たない形）だと
 * `c.req.param()` が `string | undefined` になるため（`reworks.ts` と同じ）。
 *
 * @param forcedTo `resolve` 経路は遷移先を固定する。`null` なら本文の `to`。
 */
async function runStatusChange(
  c: Context<AppEnv>,
  issueId: string,
  forcedTo: IssueStatus | null,
): Promise<Response> {
  const parsed = issueStatusRequestSchema
    .partial({ to: true })
    .safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const to = forcedTo ?? parsed.data.to;
  if (to === undefined) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const row = await findIssueReportById(c.env, ctx, issueId);
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "issue.manage", propertyTarget([row.propertyId]));

  const outcome = await changeIssueStatus(c.env, ctx, {
    issueId: row.id,
    from: row.status,
    to,
    actorId: getSession(c).membershipId,
    note: parsed.data.note ?? null,
    ...(parsed.data.resolutionNote === undefined
      ? {}
      : { resolutionNote: parsed.data.resolutionNote }),
    ...(parsed.data.assignedToId === undefined ? {} : { assignedToId: parsed.data.assignedToId }),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies IssueError, 409);
  }
  // `NOOP`（同じ状態への再送）も成功として返す（冪等 / testing.md §4）。
  return c.json({ status: to });
}

/** 写真の一覧（§8.1）。**15 分有効の署名付き URL**（security.md §4）。 */
issues.get("/:issueId/photos", async (c) => {
  const ctx = getTenant(c);
  const row = await findIssueReportById(c.env, ctx, c.req.param("issueId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "issue.read", propertyTarget([row.propertyId]));
  if (ctx.role === "CLEANER" && row.reportedById !== getSession(c).membershipId) {
    return c.notFound();
  }

  const rows = await listIssuePhotos(c.env, ctx, row.id);
  return c.json({
    data: await Promise.all(
      rows.map(async (photo) => ({
        photoId: photo.id,
        url: await signObjectUrl(c.env.SESSION_SECRET, photo.storageKey, getNow(c)),
      })),
    ),
  });
});

/** 写真のアップロード（§8.1「写真 1 枚以上」）。**`multipart/form-data`。** */
issues.post("/:issueId/photos", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const outcome = await uploadIssuePhoto(c.env, getTenant(c), {
    issueId: c.req.param("issueId"),
    bytes: new Uint8Array(await file.arrayBuffer()),
    uploadedById: getSession(c).membershipId,
  });

  if (outcome.kind === "REJECTED") {
    if (outcome.error === "INVALID_REQUEST") return c.notFound();
    return c.json({ error: outcome.error } satisfies PhotoError, 400);
  }
  return c.json({ photoId: outcome.photoId }, 201);
});

export default issues;
