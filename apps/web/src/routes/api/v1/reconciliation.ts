/**
 * 稼働照合の API（PK-SPEC-P4 §5.4）。
 *
 * ```
 * POST /api/v1/reconciliation/runs   手動実行（Queue へ）
 * ```
 *
 * task: docs/tasks/P4-05.md
 *
 * ── 差異を読む口はここに無い ────────────────────────────
 * 一覧（W-06）と詳細（W-07）は P4-06 / P4-07。**`CLEANER` / `INSPECTOR` は
 * 差異に到達できない**（§6.4 / security.md §1）。この口も
 * `reconciliation.run` を持たないロールには 404 を返す
 * （`assertPermission()` が `NotFoundError` を投げる / DECISIONS #022）。
 *
 * ── 照合をここで走らせない ──────────────────────────────
 * Queue へ投げるだけ（architecture.md §5）。客室数 × 3 系統の読み込みを
 * リクエストハンドラの CPU 予算（50ms）に載せない。
 *
 * ── 消す口・差異を作る口が無い ──────────────────────────
 * 差異は照合の結果としてのみ生まれる。手で 1 件足す口を作らない。
 */

import {
  RECONCILIATION_MAX_LOOKBACK_DAYS,
  reconciliationRunRequestSchema,
  type ReconciliationError,
  type ReconciliationRunResponse,
} from "@pk/contracts";
import { findPropertyById } from "@pk/db";
import { Hono } from "hono";

import type { ReconciliationMessage } from "../../../consumers/reconciliation.js";
import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { businessDateOf, shiftBusinessDate } from "../../../lib/businessDate.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const reconciliation = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): ReconciliationError {
  return { error: "INVALID_REQUEST" };
}

/**
 * 手動実行（§5.4）。
 *
 * ── 遡れるのは 90 日まで ────────────────────────────────
 * §5.4。**未来の業務日も断る。** まだ終わっていない日を照合すると、
 * 途中の状態で差異が立ち、あとから届く記録で説明がつかなくなる。
 *
 * ── 二重起動はここで断らない ────────────────────────────
 * 同じ施設・同じ業務日が既に走っていても 202 を返す。**排他は
 * `ReconciliationLock`（§5.2）の仕事**で、こちらで先読みして断ると、
 * 「投入したのに走らない」と「走っているから投入しない」の 2 つの経路が
 * できて、どちらが効いたのか読めなくなる。
 */
reconciliation.post("/runs", async (c) => {
  const ctx = getTenant(c);
  const body = reconciliationRunRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "reconciliation.run", propertyTarget([body.data.propertyId]));

  const property = await findPropertyById(c.env, ctx, body.data.propertyId);
  if (property === undefined) return c.notFound();

  const today = businessDateOf(ctx.now, property.timezone, property.dayCutoffTime);
  const earliest = shiftBusinessDate(today, -RECONCILIATION_MAX_LOOKBACK_DAYS);
  // 業務日は `YYYY-MM-DD` の text なので、辞書順の比較が日付順になる。
  if (body.data.businessDate > today || body.data.businessDate < earliest) {
    return c.json(invalidRequest(), 400);
  }

  const message: ReconciliationMessage = {
    kind: "RECONCILIATION",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    propertyId: property.id,
    businessDate: body.data.businessDate,
    mode: "MANUAL",
    requestedById: getSession(c).membershipId,
    requestedAtMs: ctx.now.getTime(),
  };
  await c.env.QUEUE_RECONCILIATION.send(message);

  const response: ReconciliationRunResponse = {
    propertyId: property.id,
    businessDate: body.data.businessDate,
    queued: true,
  };
  return c.json(response, 202);
});

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default reconciliation;
