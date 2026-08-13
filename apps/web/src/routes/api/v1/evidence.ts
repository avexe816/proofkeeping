/**
 * 証跡の API（PK-SPEC-P2 §14.2）。
 *
 * ```
 * GET  /api/v1/evidence?propertyId=&businessDate=   W-06 一覧
 * GET  /api/v1/evidence/tasks/:taskId               W-07 詳細
 * POST /api/v1/evidence/:snapshotId/verify          1 件の整合性確認（§6.3）
 * POST /api/v1/evidence/tasks/:taskId/export        ZIP を Queue へ（§6.5）
 * GET  /api/v1/evidence/tasks/:taskId/export        出来上がりの確認
 * ```
 *
 * task: docs/tasks/P2-09.md, docs/tasks/P2-10.md
 *
 * ── §14.2 に無い経路を 1 つ足してある ───────────────────
 * `GET /evidence/tasks/:taskId/export`。§6.5 は ZIP の生成を同期の操作の
 * ように書いているが、写真 20 枚の読み取りとハッシュは
 * **リクエストハンドラの CPU 予算（50ms / architecture.md §5）に収まらない。**
 * Queue へ渡すと「出来たか」を尋ねる口が要る。**状態を持つ表は作らず、
 * R2 にオブジェクトがあるかどうかで答える**（`consumers/evidenceExport.ts`）。
 *
 * ── `roomId` の絞りを実装していない ─────────────────────
 * §14.2 のクエリは `roomId` も挙げるが、W-06（§12.1「証跡一覧」）に
 * 客室での絞り込みの記述が無い。**引数だけ受けて無視する形にしない。**
 * 必要になった画面が `listTasks({ roomId })` を通して足すこと。
 *
 * ── `POST /evidence/:id/corrections`（§6.4）は無い ──────
 * 訂正の入口は P2-09 / P2-10 のどちらの完了条件にも無い。
 * `EvidenceSnapshot` 側は `correctsSnapshotId` を持っており（P2-08）、
 * 足すのは経路と `ORG_ADMIN` の判定だけ。docs/PROGRESS.md に残してある。
 */

import type { EvidenceVerifyResponse } from "@pk/contracts";
import { findEvidenceSnapshotById, findTaskById, listInspectionsByTask } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import {
  evidenceBundleKey,
  type EvidenceExportMessage,
} from "../../../consumers/evidenceExport.js";
import { listEvidenceForProperty, loadEvidenceDetail } from "../../../lib/evidence/detail.js";
import { verifyTaskPhotos } from "../../../lib/evidence/photoIntegrity.js";
import { verifyTaskEvidence } from "../../../lib/evidence/verify.js";
import { businessDateOf } from "../../../lib/businessDate.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getNow, getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const evidence = new Hono<AppEnv>();

/**
 * W-06 の一覧（§12.1）。**施設と業務日で引く。**
 *
 * `propertyId` はクライアントが送るが、**それを権限の対象にしていない。**
 * `assertPermission()` へ渡す値がリクエスト由来だと `ASSIGNED` の判定が
 * 何も守らない（INV-32）。ここでは `property.read` を施設 ID で判定した
 * うえで、返す行そのものは `listTasks()` のテナント・施設スコープが絞る。
 * **担当外の施設 ID を送っても 0 件になる**（`withTenantScope()`）。
 */
evidence.get("/", async (c) => {
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json({ error: "INVALID_REQUEST" }, 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "property.read", propertyTarget([propertyId]));

  const businessDate = c.req.query("businessDate") ?? businessDateOf(getNow(c));
  return c.json({ data: await listEvidenceForProperty(c.env, ctx, propertyId, businessDate) });
});

/** W-07 の詳細（§12.2）。**権限はタスクから解決した施設で見る。** */
evidence.get("/tasks/:taskId", async (c) => {
  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "task.read", propertyTarget([task.propertyId]));

  return c.json({ data: await loadEvidenceDetail(c.env, ctx, task) });
});

/**
 * 1 件の整合性確認（§6.3「整合性を確認」）。
 *
 * **snapshot 1 件を指定して呼ぶが、返すのは連鎖全体の結果。** 連鎖は
 * 前後の行との関係で決まるので、1 件だけを見ても `linkMatches` を
 * 判定できない（`verifyEvidenceChain()`）。指定された行が
 * どのタスクのものかを解決し、そのタスクの連鎖を検証する。
 *
 * ── 写真の実体照合を同時に行う ──────────────────────────
 * §6.3 は写真のバイナリ SHA-256 も照合の対象にしている。**画面を
 * 開いただけでは走らせない**（数 MB の R2 読み取りになる）。
 * この POST が押されたときだけ実体を読む
 * （`lib/evidence/photoIntegrity.ts` 冒頭）。
 */
evidence.post("/:snapshotId/verify", async (c) => {
  const ctx = getTenant(c);
  const snapshot = await findEvidenceSnapshotById(c.env, ctx, c.req.param("snapshotId"));
  if (snapshot === undefined || snapshot.taskId === null) return c.notFound();

  const task = await findTaskById(c.env, ctx, snapshot.taskId);
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "task.read", propertyTarget([task.propertyId]));

  const inspections = await listInspectionsByTask(c.env, ctx, task.id);
  const [chain, photos] = await Promise.all([
    verifyTaskEvidence(c.env, ctx, task.id),
    verifyTaskPhotos(
      c.env,
      ctx,
      { taskId: task.id, propertyId: task.propertyId },
      inspections.map((inspection) => inspection.id),
      getSession(c).membershipId,
    ),
  ]);

  const body: { chain: EvidenceVerifyResponse; photos: typeof photos } = { chain, photos };
  return c.json(body);
});

/**
 * ZIP の生成を要求する（§6.5）。**Queue へ渡して 202 を返す。**
 *
 * **`Idempotency-Key` の記録表を持たせていない。** 同じ要求が 2 回来ても
 * 同じキーへ同じ内容が書かれるだけで、結果が変わらない
 * （`consumers/evidenceExport.ts` の「冪等」）。監査ログは生成ごとに
 * 1 件増えるが、**それは「持ち出せる状態にした回数」として正しい。**
 */
evidence.post("/tasks/:taskId/export", async (c) => {
  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "evidence.export", propertyTarget([task.propertyId]));

  const message: EvidenceExportMessage = {
    kind: "EVIDENCE_ZIP",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    taskId: task.id,
    requestedById: getSession(c).membershipId,
    // **メッセージが時刻を持つ。** 再送で manifest が変わらないようにする。
    requestedAtMs: getNow(c).getTime(),
  };
  await c.env.QUEUE_EVIDENCE_EXPORT.send(message);

  return c.json({ status: "QUEUED" }, 202);
});

/**
 * 出来上がりの確認（§14.2 に無い追加の口 / 冒頭の注記）。
 *
 * 出来ていれば**15 分有効の署名付き URL**を返す（security.md §4）。
 * まだなら `PENDING`。**「失敗した」を返せない**のは状態の表を
 * 持たないため。コンシューマ側は失敗を retry するので、
 * 恒久的に出来ない入力（タスクが消えた等）だけが `PENDING` のまま残る。
 */
evidence.get("/tasks/:taskId/export", async (c) => {
  const ctx = getTenant(c);
  const task = await findTaskById(c.env, ctx, c.req.param("taskId"));
  if (task === undefined) return c.notFound();
  assertPermission(ctx, "evidence.export", propertyTarget([task.propertyId]));

  const key = evidenceBundleKey(ctx.organizationId, task.id);
  const object = await c.env.EVIDENCE.head(key);
  if (object === null) return c.json({ status: "PENDING" });

  return c.json({
    status: "READY",
    url: await signObjectUrl(c.env.SESSION_SECRET, key, getNow(c)),
    bytes: object.size,
    generatedAt: object.uploaded.toISOString(),
  });
});

export default evidence;
