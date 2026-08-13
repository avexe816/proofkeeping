/**
 * 検査の API（PK-SPEC-P2 §4.2〜§4.5 / §14.1）。
 *
 * ```
 * GET    /api/v1/inspections/waiting?propertyId=&businessDate=   M-08
 * GET    /api/v1/inspections/:inspectionId
 * PUT    /api/v1/inspections/:inspectionId/items      1 項目ずつ
 * POST   /api/v1/inspections/:inspectionId/photos     multipart/form-data
 * POST   /api/v1/inspections/:inspectionId/complete
 * ```
 *
 * 検査の開始だけはタスク側にある（`POST /tasks/:taskId/inspection/start`）。
 * §14.1 の経路名がそうなっているためで、実装は `lib/inspection/start.ts`。
 *
 * task: docs/tasks/P2-04.md
 *
 * ── この task が作らないもの ────────────────────────────
 *   - `POST /reworks/:id/{start,complete,waive}` … P2-07
 *   - `EvidenceSnapshot` の生成 … P2-08
 *
 * `GET /inspections/waiting` は P2-05 が足した（M-08 と同じ並びを返す）。
 *
 * ── `Idempotency-Key` ───────────────────────────────────
 * §14.1 は「全状態変更 API に必須」。開始は `inspection.idempotencyKey` で
 * 弾く。**項目の記録と完了は、操作そのものが冪等**（同じ項目を同じ値で
 * 書き直しても結果が変わらない / 確定済みの検査は結果をそのまま返す）
 * なので、鍵の記録表を増やしていない（DECISIONS #065）。
 */

import {
  inspectionCompleteRequestSchema,
  inspectionItemUpdateRequestSchema,
  inspectionPhotoUploadMetaSchema,
  type InspectionDetailResponse,
  type InspectionError,
  type InspectionPhotoUploadResponse,
  type PhotoError,
} from "@pk/contracts";
import {
  findInspectionById,
  findRoomById,
  findTaskById,
  recordInspectionItemResult,
  type Env,
  type TenantContext,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { businessDateOf } from "../../../lib/businessDate.js";
import { completeInspectionUseCase } from "../../../lib/inspection/complete.js";
import { listInspectionItems, toInspection } from "../../../lib/inspection/detail.js";
import { buildWaitingList } from "../../../lib/inspection/waiting.js";
import { uploadInspectionPhoto } from "../../../lib/photo/inspectionUpload.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getNow, getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const inspections = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): InspectionError {
  return { error: "INVALID_REQUEST" };
}

/**
 * 検査待ち一覧（M-08 / §11.2）。
 *
 * ```
 * GET /api/v1/inspections/waiting?propertyId=&businessDate=
 * ```
 *
 * **`/:inspectionId` より前に登録すること。** Hono は登録順に照合するので、
 * 先に `/:inspectionId` を置くと `waiting` が ID として吸われる
 * （`routes/api/v1/tasks.ts` 冒頭の「登録の順序が意味を持つ」と同じ）。
 */
inspections.get("/waiting", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const businessDate = c.req.query("businessDate") ?? businessDateOf(getNow(c));

  if (propertyId === undefined) return c.json(invalidRequest(), 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return c.json(invalidRequest(), 400);

  // 施設は絞り込みに使い、**同じ値で権限も判定する**（担当外なら 404）。
  assertPermission(ctx, "inspection.read", propertyTarget([propertyId]));

  return c.json(await buildWaitingList(c.env, ctx, propertyId, businessDate, getNow(c)));
});

/** 検査 1 件（M-09 が読む）。**項目を必ず添える。** */
inspections.get("/:inspectionId", async (c) => {
  const ctx = getTenant(c);
  const row = await findInspectionById(c.env, ctx, c.req.param("inspectionId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "inspection.read", propertyTarget([row.propertyId]));

  const body = await buildDetail(c.env, ctx, row);
  if (body === null) return c.notFound();
  return c.json(body);
});

/**
 * 検査項目の記録（§4.3）。**1 項目ずつ。**
 *
 * 配列を受ける口を作らない。作れば「全項目 PASS」を 1 回で送れてしまい、
 * 画面から「全て合格」を消しても同じことができる（P2 固有の絶対ルール）。
 */
inspections.put("/:inspectionId/items", async (c) => {
  const parsed = await readJson(c.req.raw);
  const body = inspectionItemUpdateRequestSchema.safeParse(parsed);
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const row = await findInspectionById(c.env, ctx, c.req.param("inspectionId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "inspection.write", propertyTarget([row.propertyId]));

  // **確定済みの検査は書き換えられない。** 訂正は次のラウンドで行う。
  if (row.result !== null) {
    return c.json({ error: "INSPECTION_ALREADY_COMPLETED" } satisfies InspectionError, 409);
  }

  // 清掃時に展開されていない項目は記録できない（**このタスクに無い項目**）。
  const items = await listInspectionItems(c.env, ctx, row.id, row.taskId);
  if (!items.some((item) => item.checklistItemId === body.data.checklistItemId)) {
    return c.notFound();
  }

  await recordInspectionItemResult(c.env, ctx, {
    inspectionId: row.id,
    propertyId: row.propertyId,
    checklistItemId: body.data.checklistItemId,
    status: body.data.status,
    defectCode: body.data.defectCode ?? null,
    note: body.data.note ?? null,
    reworkRequired: body.data.reworkRequired,
  });

  const detail = await buildDetail(c.env, ctx, row);
  if (detail === null) return c.notFound();
  return c.json(detail);
});

/**
 * 不合格項目の写真（§4.3）。**`multipart/form-data`。**
 *
 * `clientId` が冪等鍵。EXIF の除去とハッシュの計算は
 * `uploadInspectionPhoto()` の中（サーバー側の 2 重目 / INV-11）。
 */
inspections.post("/:inspectionId/photos", async (c) => {
  const ctx = getTenant(c);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const meta = inspectionPhotoUploadMetaSchema.safeParse({
    clientId: form.get("clientId"),
    itemResultId: form.get("itemResultId"),
  });
  if (!meta.success) return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const outcome = await uploadInspectionPhoto(c.env, ctx, {
    inspectionId: c.req.param("inspectionId"),
    itemResultId: meta.data.itemResultId,
    clientId: meta.data.clientId,
    bytes: new Uint8Array(await file.arrayBuffer()),
    uploadedById: getSession(c).membershipId,
  });

  if (outcome.kind === "REJECTED") {
    // 検査・項目が無い場合は `INVALID_REQUEST` で返ってくる。**404 に写す**
    // （資源の存在を推測させない / INV-31）。
    if (outcome.error === "INVALID_REQUEST") return c.notFound();
    return c.json({ error: outcome.error } satisfies PhotoError, PHOTO_ERROR_STATUS[outcome.error]);
  }

  const body: InspectionPhotoUploadResponse = {
    data: {
      photoId: outcome.photo.photoId,
      inspectionId: outcome.photo.inspectionId,
      itemResultId: outcome.photo.itemResultId,
      width: outcome.photo.width,
      height: outcome.photo.height,
      fileSize: outcome.photo.fileSize,
      sha256: outcome.photo.sha256,
      uploadedAt: outcome.photo.uploadedAt,
      url: await signObjectUrl(c.env.SESSION_SECRET, outcome.photo.storageKey, getNow(c)),
    },
    unchanged: outcome.unchanged,
  };
  return c.json(body);
});

/**
 * 検査の確定（§4.4 / §4.5）。
 *
 * **判定を受け取らない。** 項目の集約で決まる（§4.3 MUST）。
 */
inspections.post("/:inspectionId/complete", async (c) => {
  const parsed = await readJson(c.req.raw);
  const body = inspectionCompleteRequestSchema.safeParse(parsed ?? {});
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const outcome = await completeInspectionUseCase(c.env, ctx, {
    inspectionId: c.req.param("inspectionId"),
    actorId: getSession(c).membershipId,
    generalNote: body.data.generalNote,
    ip: c.req.header("CF-Connecting-IP"),
  });

  if (outcome.kind === "REJECTED") {
    const error: InspectionError = {
      error: outcome.error,
      ...(outcome.details === undefined ? {} : { details: outcome.details }),
    };
    return c.json(error, 409);
  }

  return c.json(outcome.body);
});

/**
 * 写真のエラーに対する HTTP ステータス（`routes/api/v1/tasks.ts` と同じ表）。
 *
 * 検査写真に枚数の上限を設けていないため `PHOTO_LIMIT_EXCEEDED` は
 * 返らないが、**表は同じ形にしておく**（片方だけ欠けた表を作らない）。
 */
const PHOTO_ERROR_STATUS = {
  INVALID_REQUEST: 400,
  PHOTO_LIMIT_EXCEEDED: 409,
  PHOTO_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE: 415,
} as const satisfies Record<string, 400 | 409 | 413 | 415>;

/** 検査詳細の応答。タスクが引けなければ `null`（→ 404）。 */
async function buildDetail(
  env: Env,
  ctx: TenantContext,
  row: NonNullable<Awaited<ReturnType<typeof findInspectionById>>>,
): Promise<InspectionDetailResponse | null> {
  const task = await findTaskById(env, ctx, row.taskId);
  if (task === undefined) return null;
  const room = await findRoomById(env, ctx, task.roomId);

  return {
    data: toInspection(row, {
      taskId: task.id,
      propertyId: task.propertyId,
      businessDate: task.businessDate,
      roomNumber: room?.roomNumber ?? "",
    }),
    items: await listInspectionItems(env, ctx, row.id, row.taskId),
  };
}

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default inspections;
