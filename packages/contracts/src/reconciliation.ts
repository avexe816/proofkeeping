/**
 * 稼働照合 API の入出力（PK-SPEC-P4 §5.4）。
 *
 * task: docs/tasks/P4-05.md
 *
 * ```
 * POST /api/v1/reconciliation/runs   手動実行（Queue へ / §5.4）
 * ```
 *
 * ── 差異を読む口はここに無い ────────────────────────────
 * `/api/v1/findings`（W-06 / W-07）は P4-06 / P4-07 が作る。
 * **`CLEANER` / `INSPECTOR` には 404 を返す**（§6.4 / security.md §1）。
 *
 * ── 照合の結果をここで返さない ──────────────────────────
 * 応答は「投入した」だけ（202）。3 系統の読み込みはリクエストハンドラの
 * CPU 予算に収まらない（architecture.md §5）ので、結果は
 * `reconciliationRun` を読む画面が出す。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

/** API のエラーコード。**文言を載せない**（画面が i18n キーへ写す）。 */
export const RECONCILIATION_ERROR_CODES = ["INVALID_REQUEST", "NOT_FOUND"] as const;

export type ReconciliationErrorCode = (typeof RECONCILIATION_ERROR_CODES)[number];

export const reconciliationErrorSchema = z.object({
  error: z.enum(RECONCILIATION_ERROR_CODES),
});

export type ReconciliationError = z.infer<typeof reconciliationErrorSchema>;

/** 遡及できる日数（§5.4「過去 90 日まで遡及可能」）。 */
export const RECONCILIATION_MAX_LOOKBACK_DAYS = 90;

/**
 * 手動実行（§5.4）。
 *
 * **施設 1 つ・業務日 1 つずつ受け取る。** 期間で受け取る口にすると、
 * 押した人が想定していない量の照合が Queue に載る。全施設は夜間バッチの仕事。
 */
export const reconciliationRunRequestSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
});

export type ReconciliationRunRequest = z.infer<typeof reconciliationRunRequestSchema>;

export const reconciliationRunResponseSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
  queued: z.boolean(),
});

export type ReconciliationRunResponse = z.infer<typeof reconciliationRunResponseSchema>;
