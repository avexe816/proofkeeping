/**
 * 消耗ベースラインとデータ品質 API の入出力（PK-SPEC-P3 §5・§6.2・§6.3・§7）。
 *
 * task: docs/tasks/P3-09.md / P3-10.md / P3-12.md
 *
 * ```
 * GET   /api/v1/baselines?propertyId=&roomTypeId=&guestCount=&taskType=
 * PATCH /api/v1/baselines/:baselineId/override   手動上書き（理由必須）
 * POST  /api/v1/baselines/recompute              手動再計算（Queue へ）
 * GET   /api/v1/data-quality?propertyId=&month=
 * ```
 *
 * ── 判定を返さない ──────────────────────────────────────
 * ベースラインは統計量（§0.2）。「多い」「異常」を表す欄が無い。
 * `isReliable` は**統計の信頼性**であって、観察の良し悪しではない。
 *
 * ── データ品質は評価ではない（security.md §5 / INV-07）──
 * スタッフ別に返すのは**入力率だけ**で、所要時間・既定値率は返さない。
 * 20 タスク未満は `display: false`（画面が率を出さない）。**この欄を
 * 消して率だけを返す形にしないこと。** 画面側の実装で判断させると、
 * 別の画面が同じデータを別の閾値で出せてしまう。
 */

import { z } from "zod";

import { itemCodeSchema } from "./observation.js";
import { businessDateSchema, resourceIdSchema, taskTypeSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙
// ────────────────────────────────────────────────────────────

/** 除外理由（§5.3）。`packages/db` の `BASELINE_EXCLUSION_REASONS` と同じ並び。 */
export const BASELINE_EXCLUSION_REASONS = [
  "ZERO_WITH_BEDS_USED",
  "OVER_MEDIAN_5X",
  "INPUT_TOO_FAST",
  "REPEATED_INPUT",
  "FINDING_ATTACHED",
] as const;

export const baselineExclusionReasonSchema = z.enum(BASELINE_EXCLUSION_REASONS);

export type BaselineExclusionReasonValue = (typeof BASELINE_EXCLUSION_REASONS)[number];

/** 上書きの理由（§5.5「理由必須」）。空文字を弾く。 */
export const BASELINE_OVERRIDE_REASON_MIN_LENGTH = 1;
export const BASELINE_OVERRIDE_REASON_MAX_LENGTH = 300;

/** 上書きできる p90 の上限。観察値の上限（`MAX_OBSERVED_QTY`）と揃える。 */
export const MAX_BASELINE_QTY = 99;

/** API のエラーコード。**文言を載せない**（画面が i18n キーへ写す）。 */
export const BASELINE_ERROR_CODES = ["INVALID_REQUEST", "NOT_FOUND"] as const;

export type BaselineErrorCode = (typeof BASELINE_ERROR_CODES)[number];

export const baselineErrorSchema = z.object({
  error: z.enum(BASELINE_ERROR_CODES),
});

export type BaselineError = z.infer<typeof baselineErrorSchema>;

// ────────────────────────────────────────────────────────────
// ベースライン（§2.4 / §6.2）
// ────────────────────────────────────────────────────────────

/**
 * 1 行ぶんのベースライン（W-21 の 1 行）。
 *
 * `p90Qty` は**算出値**、`manualOverride` は上書き値（§5.5）。
 * **どちらも返す。** 上書きしたあとに算出値が見えないと、上書きを
 * 解除してよいかを判断できない。P4 が使うのは `manualOverride ?? p90Qty`。
 */
export const baselineSchema = z.object({
  id: resourceIdSchema,
  propertyId: resourceIdSchema,
  roomTypeId: resourceIdSchema,
  guestCount: z.number().int().min(0),
  taskType: taskTypeSchema,
  itemCode: itemCodeSchema,
  sampleSize: z.number().int().min(0),
  medianQty: z.number(),
  p10Qty: z.number(),
  p90Qty: z.number(),
  maxQty: z.number(),
  stdDev: z.number(),
  /** `sampleSize >= 20`（§2.4 MUST）。**偽の行は P4 の評価から外れる。** */
  isReliable: z.boolean(),
  computedFrom: businessDateSchema,
  computedTo: businessDateSchema,
  manualOverride: z.number().nullable(),
  overrideReason: z.string().nullable(),
  updatedAt: z.number().int(),
});

export type Baseline = z.infer<typeof baselineSchema>;

export const baselineListResponseSchema = z.object({
  data: z.array(baselineSchema),
});

export type BaselineListResponse = z.infer<typeof baselineListResponseSchema>;

/**
 * 手動上書き（§5.5 / W-21）。**理由必須。**
 *
 * `manualOverride: null` は解除。**解除にも理由を求める**（security.md §6 の
 * 監査対象で、`before` / `after` だけでは何を戻したのか分からないため）。
 */
export const baselineOverrideRequestSchema = z.object({
  manualOverride: z.number().min(0).max(MAX_BASELINE_QTY).nullable(),
  reason: z
    .string()
    .trim()
    .min(BASELINE_OVERRIDE_REASON_MIN_LENGTH)
    .max(BASELINE_OVERRIDE_REASON_MAX_LENGTH),
});

export type BaselineOverrideRequest = z.infer<typeof baselineOverrideRequestSchema>;

export const baselineOverrideResponseSchema = z.object({
  data: baselineSchema,
});

export type BaselineOverrideResponse = z.infer<typeof baselineOverrideResponseSchema>;

/**
 * 手動再計算（§7 の `POST /baselines/recompute`）。
 *
 * **施設を 1 つずつ受け取る。** 組織の全施設をまとめて投げる口にすると、
 * 押した人が想定していない負荷が Queue に載る。全施設は週次バッチの仕事。
 */
export const baselineRecomputeRequestSchema = z.object({
  propertyId: resourceIdSchema,
});

export type BaselineRecomputeRequest = z.infer<typeof baselineRecomputeRequestSchema>;

export const baselineRecomputeResponseSchema = z.object({
  /** 投入した業務日（ウィンドウ終端）。 */
  computedTo: businessDateSchema,
  queued: z.boolean(),
});

export type BaselineRecomputeResponse = z.infer<typeof baselineRecomputeResponseSchema>;

// ────────────────────────────────────────────────────────────
// データ品質（§6.3 / W-22）
// ────────────────────────────────────────────────────────────

/** 率 1 つ。`packages/engine` の `MetricRate` と同じ形（千分率）。 */
export const dataQualityRateSchema = z.object({
  numerator: z.number().int().min(0),
  denominator: z.number().int().min(0),
  /** 千分率（0〜1000）。**分母 0 は `null`。** 表示は 10 で割る。 */
  permille: z.number().int().nullable(),
});

export type DataQualityRate = z.infer<typeof dataQualityRateSchema>;

/** 指標の判定。**「異常」ではなく「通常と違う点」**（ui-writing.md §2）。 */
export const DATA_QUALITY_STATUSES = ["OK", "WARN", "UNKNOWN"] as const;

export const dataQualityStatusSchema = z.enum(DATA_QUALITY_STATUSES);

export type DataQualityStatusValue = (typeof DATA_QUALITY_STATUSES)[number];

/** スタッフ 1 人ぶん。**入力率だけ**（冒頭の注記）。 */
export const staffInputRateSchema = z.object({
  /** `membership.id`。 */
  assigneeId: resourceIdSchema,
  /** 表示名。**スタッフ番号を含む**（§6.3 の「田中 (08)」）。 */
  displayName: z.string(),
  rate: dataQualityRateSchema,
  /** 20 タスク未満なら偽。**偽のとき率を表示しない**（security.md §5）。 */
  display: z.boolean(),
});

export type StaffInputRateSummary = z.infer<typeof staffInputRateSchema>;

/** 客室タイプ × 人数の組み合わせ 1 つ（§6.3 下段）。 */
export const baselineMaturitySchema = z.object({
  roomTypeId: resourceIdSchema,
  roomTypeName: z.string(),
  guestCount: z.number().int().min(0),
  itemCount: z.number().int().min(0),
  reliableItemCount: z.number().int().min(0),
  isReliable: z.boolean(),
});

export type BaselineMaturitySummary = z.infer<typeof baselineMaturitySchema>;

export const dataQualityResponseSchema = z.object({
  propertyId: resourceIdSchema,
  /** 対象月 `YYYY-MM`。 */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  from: businessDateSchema,
  to: businessDateSchema,
  inputRate: dataQualityRateSchema,
  defaultRate: dataQualityRateSchema,
  /** 平均入力時間（ミリ秒）。**母数 0 は `null`。** */
  averageInputMs: z.number().int().nullable(),
  inputDurationCount: z.number().int().min(0),
  exclusionRate: dataQualityRateSchema,
  skipRate: dataQualityRateSchema,
  statuses: z.record(z.string(), dataQualityStatusSchema),
  staffInputRates: z.array(staffInputRateSchema),
  maturity: z.array(baselineMaturitySchema),
  reliableCombinationCount: z.number().int().min(0),
  totalCombinationCount: z.number().int().min(0),
});

export type DataQualityResponse = z.infer<typeof dataQualityResponseSchema>;

/** 対象月 `YYYY-MM`（`GET /data-quality?month=`）。 */
export const dataQualityMonthSchema = z.string().regex(/^\d{4}-\d{2}$/);
