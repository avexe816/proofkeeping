/**
 * 消耗ベースラインと除外記録のリポジトリ（PK-SPEC-P3 §2.4 / §5）。
 *
 * task: docs/tasks/P3-09.md（週次バッチ）/ P3-10.md（W-21 の上書き）/
 *       P3-12.md（W-22 の除外率）
 *
 * ── 再計算方式（architecture.md §3）────────────────────
 * 週次バッチは**毎回すべてを計算し直して置き換える。** 差分を足し込む
 * 形にしない（3 回動かしても結果が同じであること / testing.md §4）。
 *
 * ── 手動上書きを消さない（§5.5 MUST）──────────────────
 * `manualOverride` / `overrideReason` は `ORG_ADMIN` が入れた値で、
 * **次回の自動算出で消えない。** そのため `replaceBaselines()` は
 *   ① 既存行の統計量だけを更新し、上書き列に触れない
 *   ② 今回の集計に現れなくなった組み合わせでも、**上書きのある行は
 *      残す**（消すと理由まで消える）
 * を守る。解除は `clearBaselineOverride()` だけが行う。
 *
 * ── 判定を持ち込まない ──────────────────────────────────
 * ここにあるのは統計量と、その信頼性の印だけ（§0.2）。閾値との
 * 突き合わせは P4。
 */

import { and, eq, gte, inArray, lte } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  baselineExclusionLog,
  consumptionBaseline,
  type BaselineExclusionReason,
  type ItemCode,
} from "../schema/observation.js";
import type { TaskType } from "../schema/task.js";

import { withTenantScope } from "./base.js";

// ────────────────────────────────────────────────────────────
// ベースライン（§2.4）
// ────────────────────────────────────────────────────────────

/** `listBaselines()` の絞り込み（§7 の `GET /baselines`）。 */
export interface BaselineFilter {
  propertyId?: string | undefined;
  roomTypeId?: string | undefined;
  guestCount?: number | undefined;
  taskType?: TaskType | undefined;
}

/**
 * 一覧（W-21 / W-22 の成熟度 / P4 の照合）。
 *
 * **信頼性で絞る条件を置いていない。** W-21 は `isReliable = false` の行も
 * グレーで出す（§6.2）。P4 が除外するのは呼び出し側の判断。
 */
export async function listBaselines(env: Env, ctx: TenantContext, filter: BaselineFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(consumptionBaseline)
    .where(
      withTenantScope(
        consumptionBaseline,
        ctx,
        consumptionBaseline.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(consumptionBaseline.propertyId, filter.propertyId),
        filter.roomTypeId === undefined
          ? undefined
          : eq(consumptionBaseline.roomTypeId, filter.roomTypeId),
        filter.guestCount === undefined
          ? undefined
          : eq(consumptionBaseline.guestCount, filter.guestCount),
        filter.taskType === undefined
          ? undefined
          : eq(consumptionBaseline.taskType, filter.taskType),
      ),
    )
    .orderBy(
      consumptionBaseline.roomTypeId,
      consumptionBaseline.guestCount,
      consumptionBaseline.taskType,
      consumptionBaseline.itemCode,
    );
}

/** 1 件（上書きの入口）。越境 ID は DB へ行く前に `NotFoundError`（→ 404）。 */
export async function findBaselineById(env: Env, ctx: TenantContext, baselineId: string) {
  assertIdBelongsToTenant(baselineId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(consumptionBaseline)
    .where(
      withTenantScope(
        consumptionBaseline,
        ctx,
        consumptionBaseline.propertyId,
        eq(consumptionBaseline.id, baselineId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 置き換える 1 行ぶんの統計量（`packages/engine` の `BaselineResult`）。 */
export interface BaselineRowInput {
  roomTypeId: string;
  guestCount: number;
  taskType: TaskType;
  itemCode: ItemCode;
  sampleSize: number;
  medianQty: number;
  p10Qty: number;
  p90Qty: number;
  maxQty: number;
  stdDev: number;
  isReliable: boolean;
}

export interface ReplaceBaselinesInput {
  propertyId: string;
  /** 集計ウィンドウ（§5.4）。`YYYY-MM-DD`。 */
  computedFrom: string;
  computedTo: string;
  rows: readonly BaselineRowInput[];
}

export interface ReplaceBaselinesResult {
  /** 書いた（挿入または更新した）行数。 */
  written: number;
  /** 今回の集計に現れず、上書きも無いので消した行数。 */
  removed: number;
  /** 今回の集計に現れないが、手動上書きがあるので残した行数。 */
  keptOverridden: number;
}

/**
 * 施設 1 つぶんのベースラインを置き換える（週次バッチ / P3-09）。
 *
 * **`manualOverride` / `overrideReason` に触れない**（§5.5 MUST）。
 * 一意制約 `(organizationId, propertyId, roomTypeId, guestCount, taskType,
 * itemCode)` への upsert なので、3 回動かしても行は増えない。
 */
export async function replaceBaselines(
  env: Env,
  ctx: TenantContext,
  input: ReplaceBaselinesInput,
): Promise<ReplaceBaselinesResult> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const existing = await listBaselines(env, ctx, { propertyId: input.propertyId });
  const incoming = new Set(input.rows.map((row) => baselineRowKey(row)));

  for (const row of input.rows) {
    await db
      .insert(consumptionBaseline)
      .values({
        id: generateId(ctx.orgShortId, "bsln"),
        organizationId: ctx.organizationId,
        propertyId: input.propertyId,
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
        computedFrom: input.computedFrom,
        computedTo: input.computedTo,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [
          consumptionBaseline.organizationId,
          consumptionBaseline.propertyId,
          consumptionBaseline.roomTypeId,
          consumptionBaseline.guestCount,
          consumptionBaseline.taskType,
          consumptionBaseline.itemCode,
        ],
        // **`manualOverride` と `overrideReason` を書かない**（§5.5 MUST）。
        set: {
          sampleSize: row.sampleSize,
          medianQty: row.medianQty,
          p10Qty: row.p10Qty,
          p90Qty: row.p90Qty,
          maxQty: row.maxQty,
          stdDev: row.stdDev,
          isReliable: row.isReliable,
          computedFrom: input.computedFrom,
          computedTo: input.computedTo,
          updatedAt: ctx.now,
        },
      });
  }

  // 今回の集計に現れなかった組み合わせ（品目を設定から外した等）。
  const stale = existing.filter((row) => !incoming.has(baselineRowKey(row)));
  const removable = stale.filter((row) => row.manualOverride === null);
  for (const row of removable) {
    await db
      .delete(consumptionBaseline)
      .where(
        and(
          eq(consumptionBaseline.organizationId, ctx.organizationId),
          eq(consumptionBaseline.id, row.id),
        ),
      );
  }

  return {
    written: input.rows.length,
    removed: removable.length,
    keptOverridden: stale.length - removable.length,
  };
}

/** 手動上書き（§5.5）。**理由必須**は契約側（Zod）と呼び出し側が守る。 */
export interface SetBaselineOverrideInput {
  baselineId: string;
  /** 上書きする p90。 */
  manualOverride: number;
  reason: string;
}

/**
 * p90 を手動で上書きする（§5.5 / W-21）。
 *
 * **`p90Qty` を書き換えない。** 算出値はそのまま残し、上書きは別列に持つ。
 * 上書きを解除したときに算出値へ戻れなくなるため。読む側（P4・W-21）は
 * `manualOverride ?? p90Qty` を使う。
 */
export async function setBaselineOverride(
  env: Env,
  ctx: TenantContext,
  input: SetBaselineOverrideInput,
): Promise<{ applied: boolean }> {
  assertIdBelongsToTenant(input.baselineId, ctx);
  const existing = await findBaselineById(env, ctx, input.baselineId);
  if (existing === undefined) return { applied: false };

  const db = await getTenantDb(env, ctx);
  await db
    .update(consumptionBaseline)
    .set({
      manualOverride: input.manualOverride,
      overrideReason: input.reason,
      updatedAt: ctx.now,
    })
    .where(
      and(
        eq(consumptionBaseline.organizationId, ctx.organizationId),
        eq(consumptionBaseline.id, existing.id),
      ),
    );
  return { applied: true };
}

/**
 * 手動上書きを解除する（§5.5「解除するまで固定される」）。
 *
 * **理由も一緒に消す。** 上書きが無いのに理由だけ残ると、W-21 が
 * 「上書き中」と読める表示になる。解除そのものは監査ログに残る。
 */
export async function clearBaselineOverride(
  env: Env,
  ctx: TenantContext,
  baselineId: string,
): Promise<{ applied: boolean }> {
  assertIdBelongsToTenant(baselineId, ctx);
  const existing = await findBaselineById(env, ctx, baselineId);
  if (existing === undefined) return { applied: false };

  const db = await getTenantDb(env, ctx);
  await db
    .update(consumptionBaseline)
    .set({ manualOverride: null, overrideReason: null, updatedAt: ctx.now })
    .where(
      and(
        eq(consumptionBaseline.organizationId, ctx.organizationId),
        eq(consumptionBaseline.id, existing.id),
      ),
    );
  return { applied: true };
}

// ────────────────────────────────────────────────────────────
// 除外記録（§5.3 MUST）
// ────────────────────────────────────────────────────────────

/** `listBaselineExclusions()` の絞り込み。 */
export interface BaselineExclusionFilter {
  propertyId?: string | undefined;
  /** 業務日の下限（含む）。W-22 は月の初日。 */
  from?: string | undefined;
  /** 業務日の上限（含む）。 */
  to?: string | undefined;
  reason?: readonly BaselineExclusionReason[] | undefined;
}

/** 除外記録の一覧（W-22 の除外率 / 除外の内訳）。 */
export async function listBaselineExclusions(
  env: Env,
  ctx: TenantContext,
  filter: BaselineExclusionFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(baselineExclusionLog)
    .where(
      withTenantScope(
        baselineExclusionLog,
        ctx,
        baselineExclusionLog.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(baselineExclusionLog.propertyId, filter.propertyId),
        filter.from === undefined
          ? undefined
          : gte(baselineExclusionLog.businessDate, filter.from),
        filter.to === undefined ? undefined : lte(baselineExclusionLog.businessDate, filter.to),
        filter.reason === undefined || filter.reason.length === 0
          ? undefined
          : inArray(baselineExclusionLog.reason, [...filter.reason]),
      ),
    )
    .orderBy(baselineExclusionLog.businessDate, baselineExclusionLog.observationId);
}

/** 除外 1 件（`packages/engine` の `BaselineExclusion`）。 */
export interface BaselineExclusionRowInput {
  observationId: string;
  businessDate: string;
  roomTypeId: string;
  guestCount: number;
  taskType: TaskType;
  itemCode: ItemCode;
  reason: BaselineExclusionReason;
  qty: number;
}

export interface ReplaceBaselineExclusionsInput {
  propertyId: string;
  /** 今回の集計のウィンドウ終端（`computedTo`）。 */
  computedTo: string;
  rows: readonly BaselineExclusionRowInput[];
}

/**
 * 施設 1 つぶんの除外記録を置き換える（週次バッチ / P3-09）。
 *
 * **その施設の古い実行ぶんを消してから入れ直す。** 除外記録は
 * 「最後に走った集計で何を落としたか」を表すもので、実行のたびに
 * 積み上げると、同じ観察の除外が何十行にもなり除外率が壊れる
 * （再計算方式 / architecture.md §3）。同じメッセージを 3 回処理しても
 * 行数は変わらない（testing.md §4）。
 */
export async function replaceBaselineExclusions(
  env: Env,
  ctx: TenantContext,
  input: ReplaceBaselineExclusionsInput,
): Promise<{ written: number }> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  await db
    .delete(baselineExclusionLog)
    .where(
      and(
        eq(baselineExclusionLog.organizationId, ctx.organizationId),
        eq(baselineExclusionLog.propertyId, input.propertyId),
      ),
    );

  for (const row of input.rows) {
    await db.insert(baselineExclusionLog).values({
      id: generateId(ctx.orgShortId, "bxcl"),
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      observationId: row.observationId,
      businessDate: row.businessDate,
      roomTypeId: row.roomTypeId,
      guestCount: row.guestCount,
      taskType: row.taskType,
      itemCode: row.itemCode,
      reason: row.reason,
      qty: row.qty,
      computedTo: input.computedTo,
      excludedAt: ctx.now,
    });
  }

  return { written: input.rows.length };
}

/** 集計キーの文字列表現（`packages/engine` の `baselineKeyOf()` の施設内版）。 */
function baselineRowKey(row: {
  roomTypeId: string;
  guestCount: number;
  taskType: string;
  itemCode: string;
}): string {
  return [row.roomTypeId, String(row.guestCount), row.taskType, row.itemCode].join("|");
}
