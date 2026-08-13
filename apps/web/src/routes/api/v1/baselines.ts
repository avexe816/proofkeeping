/**
 * 消耗ベースラインの API（PK-SPEC-P3 §7）。
 *
 * ```
 * GET   /api/v1/baselines?propertyId=&roomTypeId=&guestCount=&taskType=
 * PATCH /api/v1/baselines/:baselineId/override   手動上書き（理由必須 / §5.5）
 * POST  /api/v1/baselines/recompute              手動再計算（Queue へ）
 * ```
 *
 * task: docs/tasks/P3-09.md（再計算）/ P3-10.md（上書き）
 *
 * ── 削除の口が無い ──────────────────────────────────────
 * `DELETE` を作らない。ベースラインは週次バッチが置き換えるもので、
 * 消す操作に意味が無い（消しても次の日曜に戻る）。品目を画面から外すのは
 * W-20（`observationConfig.enabledItemCodes`）。
 *
 * ── 統計量を直接書かせない ──────────────────────────────
 * `PATCH` が受け取るのは `manualOverride`（p90 の上書き）と理由だけ。
 * 中央値・サンプル数を人が入れられると、**算出値と手入力が混ざった行**が
 * できて、どちらが根拠なのか読めなくなる（§5.5 は p90 だけを許す）。
 *
 * ── 計算をここでしない ──────────────────────────────────
 * `POST /recompute` は Queue へ投げるだけ（architecture.md §5）。
 * 90 日ぶんの観察の読み込みをリクエストハンドラに載せない。
 */

import {
  baselineOverrideRequestSchema,
  baselineRecomputeRequestSchema,
  type Baseline,
  type BaselineError,
  type BaselineListResponse,
  type BaselineOverrideResponse,
  type BaselineRecomputeResponse,
} from "@pk/contracts";
import {
  clearBaselineOverride,
  findBaselineById,
  findPropertyById,
  listBaselines,
  recordAudit,
  setBaselineOverride,
  TASK_TYPES,
  type TaskType,
} from "@pk/db";
import { Hono } from "hono";

import { DEFAULT_BASELINE_WINDOW_DAYS } from "../../../lib/baseline/window.js";
import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { businessDateOf, previousBusinessDate } from "../../../lib/businessDate.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";
import type { BaselineLearningMessage } from "../../../consumers/baselineLearning.js";

const baselines = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): BaselineError {
  return { error: "INVALID_REQUEST" };
}

/** DB の行を契約の形へ。**上書き値と算出値を両方返す**（`contracts/baseline.ts`）。 */
function toBaseline(row: Awaited<ReturnType<typeof listBaselines>>[number]): Baseline {
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    guestCount: row.guestCount,
    taskType: row.taskType,
    itemCode: row.itemCode,
    sampleSize: row.sampleSize,
    medianQty: row.medianQty,
    p10Qty: row.p10Qty,
    p90Qty: row.p90Qty,
    maxQty: row.maxQty,
    stdDev: row.stdDev,
    isReliable: row.isReliable,
    computedFrom: row.computedFrom,
    computedTo: row.computedTo,
    manualOverride: row.manualOverride,
    overrideReason: row.overrideReason,
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * 一覧（W-21 / §6.2）。
 *
 * **`isReliable` で絞るクエリを受け付けない。** W-21 は信頼性 `×` の行も
 * グレーで出す（§6.2）。絞り込みを API 側で持つと、画面が「出さない」を
 * 選べなくなる。
 */
baselines.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const roomTypeId = c.req.query("roomTypeId");
  const guestCountRaw = c.req.query("guestCount");
  const taskTypeRaw = c.req.query("taskType");

  let guestCount: number | undefined;
  if (guestCountRaw !== undefined) {
    const parsed = Number.parseInt(guestCountRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 0) return c.json(invalidRequest(), 400);
    guestCount = parsed;
  }

  let taskType: TaskType | undefined;
  if (taskTypeRaw !== undefined) {
    if (!(TASK_TYPES as readonly string[]).includes(taskTypeRaw)) {
      return c.json(invalidRequest(), 400);
    }
    taskType = taskTypeRaw as TaskType;
  }

  assertPermission(
    ctx,
    "baseline.read",
    propertyId === undefined ? propertyTarget(ctx.allowedPropertyIds) : propertyTarget([propertyId]),
  );

  const rows = await listBaselines(c.env, ctx, { propertyId, roomTypeId, guestCount, taskType });
  const body: BaselineListResponse = { data: rows.map(toBaseline) };
  return c.json(body);
});

/**
 * p90 の手動上書き（§5.5 / W-21）。**理由必須・監査ログ。**
 *
 * `manualOverride: null` は解除。**解除にも理由を求める**
 * （`contracts/baseline.ts` の注記）。権限が無い・別組織・担当外は 404
 * （`assertPermission()` が `NotFoundError` を投げる / INV-31）。
 */
baselines.patch("/:baselineId/override", async (c) => {
  const ctx = getTenant(c);
  const baselineId = c.req.param("baselineId");

  const body = baselineOverrideRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const before = await findBaselineById(c.env, ctx, baselineId);
  if (before === undefined) return c.notFound();

  assertPermission(ctx, "baseline.override", propertyTarget([before.propertyId]));

  if (body.data.manualOverride === null) {
    await clearBaselineOverride(c.env, ctx, baselineId);
  } else {
    await setBaselineOverride(c.env, ctx, {
      baselineId,
      manualOverride: body.data.manualOverride,
      reason: body.data.reason,
    });
  }

  const after = await findBaselineById(c.env, ctx, baselineId);
  if (after === undefined) return c.notFound();

  // security.md §6「組織設定の変更」。ベースラインの上書きは P4 の判定を
  // 動かすので、**理由を含めて残す**（`AUDIT_ACTIONS` は閉じたレジストリで、
  // 専用の行の根拠が無いため施設設定の更新として記録する / W-20 と同じ扱い）。
  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "property.updated",
    targetType: "consumptionBaseline",
    targetId: baselineId,
    propertyId: before.propertyId,
    before: { manualOverride: before.manualOverride, overrideReason: before.overrideReason },
    after: {
      manualOverride: after.manualOverride,
      overrideReason: after.overrideReason,
      reason: body.data.reason,
    },
  });

  const response: BaselineOverrideResponse = { data: toBaseline(after) };
  return c.json(response);
});

/**
 * 手動再計算（§7）。**Queue へ投げるだけ。**
 *
 * ウィンドウ終端は施設の**前の業務日**（週次バッチと同じ理由 /
 * `lib/baseline/dispatch.ts`）。まだ終わっていない日を終端にすると、
 * 押した時刻によって最終日のサンプル数が変わる。
 */
baselines.post("/recompute", async (c) => {
  const ctx = getTenant(c);
  const body = baselineRecomputeRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  // **上書きと同じ権限を要求する。** 再計算は上書き以外の全列を書き直す。
  assertPermission(ctx, "baseline.override", propertyTarget([body.data.propertyId]));

  const property = await findPropertyById(c.env, ctx, body.data.propertyId);
  if (property === undefined) return c.notFound();

  const computedTo = previousBusinessDate(
    businessDateOf(ctx.now, property.timezone, property.dayCutoffTime),
  );

  const message: BaselineLearningMessage = {
    kind: "BASELINE_LEARNING",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    propertyId: property.id,
    computedTo,
    windowDays: DEFAULT_BASELINE_WINDOW_DAYS,
    mode: "MANUAL",
    requestedById: getSession(c).membershipId,
    requestedAtMs: ctx.now.getTime(),
  };
  await c.env.QUEUE_BASELINE_LEARNING.send(message);

  const response: BaselineRecomputeResponse = { computedTo, queued: true };
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

export default baselines;
