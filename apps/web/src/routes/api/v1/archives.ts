/**
 * 退避データの復元と閲覧（PK-SPEC-P7 §9 / P7-09）。
 *
 * ```
 * GET  /api/v1/archives/restores            一覧
 * POST /api/v1/archives/restores            復元を要求（§9.1 の手順 1）
 * GET  /api/v1/archives/restores/:restoreId 詳細
 * GET  /api/v1/archives/restores/:restoreId/rows  展開した行
 * ```
 *
 * task: docs/tasks/P7-09.md
 *
 * ── 「削除」ではなく「退避」（§9 MUST）───────────────────
 * **この経路に退避を消す口が無い。** 期限が来て読めなくなるのは
 * 復元した写しだけで、R2 のオブジェクトと `archive_manifest` は残る。
 * 文言は画面（`routes/app/archive.tsx`）が i18n キーで出す。
 *
 * ── 期限切れは 404 にしない ──────────────────────────────
 * `EXPIRED` の行は残し、状態として返す。**「もう読めません。もう一度
 * 復元してください」と言えるようにするため。** 404 にすると
 * 「そんな要求は無かった」ことになり、退避が消えたようにも読める。
 */

import {
  createArchiveRestore,
  findArchiveRestoreById,
  isRestoreViewable,
  listArchiveRestoreRows,
  listArchiveRestores,
  recordAudit,
  type ArchiveRestoreRejection,
} from "@pk/db";
import { archiveRestoreCreateRequestSchema, type ArchiveRestoreView } from "@pk/contracts";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

import type { ArchiveRestoreMessage } from "../../../consumers/archiveRestore.js";

const archives = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

/** JSON を読む。**壊れていたら `null`。** */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 行 → 応答。**時刻はミリ秒**（画面が施設のタイムゾーンで出す）。 */
function toView(row: {
  id: string;
  propertyId: string | null;
  fromBusinessDate: string;
  toBusinessDate: string;
  status: ArchiveRestoreView["status"];
  tableCount: number;
  rowCount: number;
  expiresAt: Date | null;
  errorCode: string | null;
  requestedAt: Date;
  completedAt: Date | null;
}): ArchiveRestoreView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    fromBusinessDate: row.fromBusinessDate,
    toBusinessDate: row.toBusinessDate,
    status: row.status,
    tableCount: row.tableCount,
    rowCount: row.rowCount,
    expiresAtMs: row.expiresAt?.getTime() ?? null,
    errorCode: row.errorCode,
    requestedAtMs: row.requestedAt.getTime(),
    completedAtMs: row.completedAt?.getTime() ?? null,
  };
}

/** 拒否の理由 → HTTP。**409 は「いま無理」、400 は「その要求が無理」。** */
function rejectionStatus(reason: ArchiveRestoreRejection): 400 | 409 {
  return reason === "ALREADY_RUNNING" ? 409 : 400;
}

archives.get("/restores", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "archive.read", propertyTarget([]));

  const rows = await listArchiveRestores(c.env, ctx);
  return c.json({ data: rows.map(toView) });
});

/**
 * 復元を要求する（§9.1 の手順 1）。
 *
 * **同時実行は組織あたり 1 件**（§9.2）。走っていれば 409。
 * 期間は最大 3 か月（同）。超えていれば 400。
 */
archives.post("/restores", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "archive.restore", propertyTarget([]));

  const parsed = await readJson(c.req.raw);
  if (parsed === null) return c.json(invalidRequest(), 400);
  const body = archiveRestoreCreateRequestSchema.safeParse(parsed);
  if (!body.success) return c.json(invalidRequest(), 400);

  const outcome = await createArchiveRestore(c.env, ctx, {
    requestedById: getSession(c).membershipId,
    propertyId: body.data.propertyId,
    fromBusinessDate: body.data.fromBusinessDate,
    toBusinessDate: body.data.toBusinessDate,
  });
  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.reason }, rejectionStatus(outcome.reason));
  }

  const message: ArchiveRestoreMessage = {
    kind: "ARCHIVE_RESTORE",
    orgShortId: ctx.orgShortId,
    restoreId: outcome.id,
    requestedAtMs: ctx.now.getTime(),
  };
  // **展開は Queue の中でやる**（architecture.md §5）。R2 の読み取りと
  // gunzip はリクエストハンドラの CPU 予算に収まらない。
  await c.env.QUEUE_ARCHIVE_RESTORE.send(message);

  // security.md §6「データエクスポート・証跡 ZIP 出力」と同じ重み。
  // **13 か月以上前の記録を読む操作**なので、誰がいつ要求したかを残す。
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "export.data",
    targetType: "archiveRestore",
    targetId: outcome.id,
    after: {
      fromBusinessDate: body.data.fromBusinessDate,
      toBusinessDate: body.data.toBusinessDate,
      propertyId: body.data.propertyId,
    },
    ip: c.req.header("CF-Connecting-IP"),
  });

  const created = await findArchiveRestoreById(c.env, ctx, outcome.id);
  return c.json(created === undefined ? { error: "INTERNAL_ERROR" } : toView(created), 202);
});

archives.get("/restores/:restoreId", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "archive.read", propertyTarget([]));

  const row = await findArchiveRestoreById(c.env, ctx, c.req.param("restoreId"));
  if (row === undefined) return c.notFound();
  return c.json(toView(row));
});

/**
 * 展開した行を返す（§9.2「7 日間閲覧可能」）。
 *
 * **期限を過ぎたら行を返さない。** 行そのものは
 * `expireArchiveRestores()` が消すが、消えるまでの間も読ませない
 * （期限の判定を掃除の実行時刻に依存させない）。
 */
archives.get("/restores/:restoreId/rows", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "archive.read", propertyTarget([]));

  const restore = await findArchiveRestoreById(c.env, ctx, c.req.param("restoreId"));
  if (restore === undefined) return c.notFound();
  if (restore.status !== "READY" || !isRestoreViewable(restore.expiresAt, ctx.now)) {
    return c.json({ error: "RESTORE_NOT_VIEWABLE" }, 409);
  }

  const table = c.req.query("table");
  const rows = await listArchiveRestoreRows(c.env, ctx, {
    restoreId: restore.id,
    tableName: table === undefined || table === "" ? undefined : table,
  });

  return c.json({
    data: rows.map((row) => ({
      id: row.id,
      tableName: row.tableName,
      businessDate: row.businessDate,
      // 保存してあるのは JSONL の 1 行。**そのまま渡す。**
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    })),
  });
});

export default archives;
