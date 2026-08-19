/**
 * スタッフ支払集計の入出力（P5-18 / docs/PK-SPEC-PAY.md）。
 *
 * ルール: .claude/rules/billing.md §4（整数円）/ security.md §5
 *
 * **控除（社会保険・源泉・年末調整）の項目を足さないこと**（PAY §0.2 MUST）。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema, taskTypeSchema } from "./task.js";

/** 雇用区分（PAY §1.1）。`packages/db` の `EMPLOYMENT_TYPES` と同じ語彙。 */
export const EMPLOYMENT_TYPE_VALUES = ["FULL_TIME", "PART_TIME", "CONTRACTOR"] as const;

export const employmentTypeSchema = z.enum(EMPLOYMENT_TYPE_VALUES);

export type EmploymentTypeValue = (typeof EMPLOYMENT_TYPE_VALUES)[number];

/** 単価の種類（PAY §1.2）。 */
export const PAY_UNIT_TYPE_VALUES = ["PER_TASK", "HOURLY"] as const;

export const payUnitTypeSchema = z.enum(PAY_UNIT_TYPE_VALUES);

/** 支払期間の状態（PAY §3.1）。 */
export const PAYOUT_PERIOD_STATUS_VALUES = ["OPEN", "REVIEWING", "CONFIRMED"] as const;

export const payoutPeriodStatusSchema = z.enum(PAYOUT_PERIOD_STATUS_VALUES);

/** 対象月（`YYYY-MM`）。期間はサーバーが導く — リクエストで日付範囲を受けない。 */
export const payoutMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** スタッフの支払属性の登録・更新。 */
export const staffPayProfileUpsertRequestSchema = z.object({
  membershipId: resourceIdSchema,
  employmentType: employmentTypeSchema,
  /** 適格請求書発行事業者の登録番号。CONTRACTOR のみ。 */
  invoiceRegistrationNo: z
    .string()
    .regex(/^T\d{13}$/)
    .nullish(),
  isActive: z.boolean().default(true),
});

export type StaffPayProfileUpsertRequest = z.infer<typeof staffPayProfileUpsertRequestSchema>;

/** 支払単価の登録。**更新は無い**（値の変更は行の追加＋旧行を閉じる）。 */
export const payRuleCreateRequestSchema = z.object({
  membershipId: resourceIdSchema.nullish(),
  propertyId: resourceIdSchema.nullish(),
  taskType: taskTypeSchema.nullish(),
  unitType: payUnitTypeSchema,
  /** 円。整数のみ（billing.md §4）。 */
  unitPrice: z.number().int().min(0).max(10_000_000),
  validFrom: businessDateSchema.nullish(),
  validTo: businessDateSchema.nullish(),
  priority: z.number().int().min(0).max(10_000).default(100),
});

export type PayRuleCreateRequest = z.infer<typeof payRuleCreateRequestSchema>;

/** 集計の実行。省略時は有効な支払属性を持つ全スタッフ。 */
export const payoutAggregateRequestSchema = z.object({
  month: payoutMonthSchema,
  membershipId: resourceIdSchema.optional(),
});

export type PayoutAggregateRequest = z.infer<typeof payoutAggregateRequestSchema>;

/** 調整行の追加（PAY §1.4）。**理由必須。** */
export const payoutAdjustmentRequestSchema = z.object({
  lineType: z.enum(["ADJUSTMENT", "REIMBURSEMENT"]),
  description: z.string().trim().min(1).max(120),
  /** 円。マイナス（赤伝の訂正）も取りうる。 */
  amount: z.number().int().min(-10_000_000).max(10_000_000),
  reason: z.string().trim().min(1).max(500),
});

export type PayoutAdjustmentRequest = z.infer<typeof payoutAdjustmentRequestSchema>;

/** 期間の要約（一覧）。 */
export const payoutPeriodSummarySchema = z.object({
  payoutPeriodId: z.string(),
  membershipId: z.string(),
  /** 表示名。支払の運用に要る（security.md §5 の序列化禁止は画面の責務）。 */
  staffName: z.string(),
  staffNumber: z.string(),
  employmentType: employmentTypeSchema.nullable(),
  periodFrom: businessDateSchema,
  periodTo: businessDateSchema,
  status: payoutPeriodStatusSchema,
  documentNo: z.string().nullable(),
  totalAmount: z.number().int(),
});

export type PayoutPeriodSummary = z.infer<typeof payoutPeriodSummarySchema>;

export const payoutListResponseSchema = z.object({
  data: z.array(payoutPeriodSummarySchema),
});

export type PayoutListResponse = z.infer<typeof payoutListResponseSchema>;

/** 明細行。 */
export const payoutLineSchema = z.object({
  lineNo: z.number().int(),
  lineType: z.enum(["TASK", "ADJUSTMENT", "REIMBURSEMENT"]),
  propertyId: z.string().nullable(),
  description: z.string(),
  quantity: z.number().int(),
  unitType: payUnitTypeSchema.nullable(),
  unitPrice: z.number().int(),
  amount: z.number().int(),
  /** TASK 行の集計元（証跡ドリルダウン / PAY §1.4）。 */
  taskCount: z.number().int(),
  reason: z.string().nullable(),
  warning: z.string().nullable(),
});

export type PayoutLine = z.infer<typeof payoutLineSchema>;

export const payoutLinesResponseSchema = z.object({
  payoutPeriodId: z.string(),
  status: payoutPeriodStatusSchema,
  totalAmount: z.number().int(),
  lines: z.array(payoutLineSchema),
});

export type PayoutLinesResponse = z.infer<typeof payoutLinesResponseSchema>;
