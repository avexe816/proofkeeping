/**
 * 取引先マスタと料金設定 API の入出力（PK-SPEC-P5 §2.1・§2.2）。
 *
 * task: docs/tasks/P5-02.md / docs/tasks/P5-03.md
 *
 * ```
 * GET   /api/v1/counterparties
 * POST  /api/v1/counterparties
 * PATCH /api/v1/counterparties/:counterpartyId
 * GET   /api/v1/pricing-rules?counterpartyId=
 * POST  /api/v1/pricing-rules
 * POST  /api/v1/pricing-rules/:pricingRuleId/close
 * ```
 *
 * ── 宿泊者の情報を受け取る欄が無い ──────────────────────
 * security.md §3。取引先は**法人・事業者**で、`contactName` は
 * 先方の担当者。宿泊者の氏名・連絡先を入れる欄を足さないこと。
 *
 * ── 削除の口が無い ──────────────────────────────────────
 * 取引を終えた相手は `isActive = false`。過去の請求書が参照している
 * （PK-SPEC-P0 §24.4 と同じ方針）。
 *
 * ── 料金設定に更新の口が無い ────────────────────────────
 * §2.2 は `validFrom` / `validTo` を持つので、**値上げは行の追加**。
 * 既存の行を書き換えると、過去の請求書の根拠（当時いくらだったか）が
 * 変わる。終了は期間を閉じる別の操作（P5-03 の `close`）。
 */

import { z } from "zod";

import { TAX_ROUNDING_MODES } from "./property.js";
import { resourceIdSchema } from "./task.js";

/** API のエラーコード。**文言を載せない**（画面が i18n キーへ写す）。 */
export const COUNTERPARTY_ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "DUPLICATE_CODE",
] as const;

export type CounterpartyErrorCode = (typeof COUNTERPARTY_ERROR_CODES)[number];

export const counterpartyErrorSchema = z.object({ error: z.enum(COUNTERPARTY_ERROR_CODES) });

export type CounterpartyError = z.infer<typeof counterpartyErrorSchema>;

/**
 * 端数処理（billing.md §4）。
 *
 * **語彙は `property.ts` が既に持っている**（組織の税務プロファイル）。
 * 取引先ごとの設定は組織の既定を上書きするもので、語彙そのものは 1 つ。
 * **写経しない。**
 */
export const taxRoundingModeSchema = z.enum(TAX_ROUNDING_MODES);

export type TaxRoundingModeValue = (typeof TAX_ROUNDING_MODES)[number];

/** 請求明細の品目コード（§2.4）。`packages/db` の `INVOICE_ITEM_CODES` と同じ並び。 */
export const INVOICE_ITEM_CODES = [
  "CLEAN_CHECKOUT",
  "CLEAN_STAYOVER",
  "CLEAN_DEEP",
  "CLEAN_COMMON",
  "REWORK",
  "LINEN_DAMAGE",
  "EXTRA_REQUEST",
  "LATE_CHECKOUT",
  "HOLIDAY_SURCHARGE",
  "ADJUSTMENT",
] as const;

export const invoiceItemCodeSchema = z.enum(INVOICE_ITEM_CODES);

export type InvoiceItemCodeValue = (typeof INVOICE_ITEM_CODES)[number];

/** 取引先コードの長さ。**組織内で一意**（`uq_cp`）。 */
export const COUNTERPARTY_CODE_MAX_LENGTH = 32;

/** 名称・住所の長さ。 */
export const COUNTERPARTY_NAME_MAX_LENGTH = 128;
export const COUNTERPARTY_ADDRESS_MAX_LENGTH = 128;

/** CC の宛先数。**増やすときは送信側（Resend）の上限を確かめること。** */
export const MAX_CC_EMAILS = 10;

/**
 * 適格請求書発行事業者の登録番号（billing.md §1）。
 *
 * `T` + 13 桁。**形式だけを見る。** 実在するかは国税庁の照会が要り、
 * ここでは確かめられない（未設定なら `isQualifiedInvoice = false` に
 * なるだけで、請求そのものは出せる / billing.md §1）。
 */
export const invoiceRegistrationNoSchema = z.string().regex(/^T\d{13}$/);

/** 締め日（1〜31）。**31 は月末の意味。** */
export const closingDaySchema = z.number().int().min(1).max(31);

/** 支払サイト（日）。0 は「即時」。 */
export const paymentTermDaysSchema = z.number().int().min(0).max(365);

/** 取引先の登録・更新（§2.1）。 */
export const counterpartyUpsertRequestSchema = z.object({
  code: z.string().min(1).max(COUNTERPARTY_CODE_MAX_LENGTH),
  legalName: z.string().min(1).max(COUNTERPARTY_NAME_MAX_LENGTH),
  displayName: z.string().max(COUNTERPARTY_NAME_MAX_LENGTH).nullable().default(null),
  invoiceRegistrationNo: invoiceRegistrationNoSchema.nullable().default(null),
  postalCode: z.string().max(16).nullable().default(null),
  address1: z.string().max(COUNTERPARTY_ADDRESS_MAX_LENGTH).nullable().default(null),
  address2: z.string().max(COUNTERPARTY_ADDRESS_MAX_LENGTH).nullable().default(null),
  department: z.string().max(COUNTERPARTY_NAME_MAX_LENGTH).nullable().default(null),
  /** 先方の担当者。**宿泊者ではない**（security.md §3）。 */
  contactName: z.string().max(COUNTERPARTY_NAME_MAX_LENGTH).nullable().default(null),
  billingEmail: z.email(),
  ccEmails: z.array(z.email()).max(MAX_CC_EMAILS).default([]),
  closingDay: closingDaySchema.default(31),
  paymentTermDays: paymentTermDaysSchema.default(30),
  taxRoundingMode: taxRoundingModeSchema.default("FLOOR"),
  isActive: z.boolean().default(true),
});

export type CounterpartyUpsertRequest = z.infer<typeof counterpartyUpsertRequestSchema>;

/** 取引先 1 件。 */
export const counterpartySchema = z.object({
  id: resourceIdSchema,
  code: z.string(),
  legalName: z.string(),
  displayName: z.string().nullable(),
  invoiceRegistrationNo: z.string().nullable(),
  /**
   * 適格請求書を出せるか（billing.md §1）。
   * **登録番号の有無から導く。** 画面が判定を持たないようにする。
   */
  isQualifiedIssuer: z.boolean(),
  postalCode: z.string().nullable(),
  address1: z.string().nullable(),
  address2: z.string().nullable(),
  department: z.string().nullable(),
  contactName: z.string().nullable(),
  billingEmail: z.string(),
  ccEmails: z.array(z.string()),
  closingDay: z.number().int(),
  paymentTermDays: z.number().int(),
  taxRoundingMode: taxRoundingModeSchema,
  isActive: z.boolean(),
});

export type CounterpartySummary = z.infer<typeof counterpartySchema>;

export const counterpartyListResponseSchema = z.object({ data: z.array(counterpartySchema) });

export type CounterpartyListResponse = z.infer<typeof counterpartyListResponseSchema>;

export const counterpartyUpsertResponseSchema = z.object({ data: counterpartySchema });

export type CounterpartyUpsertResponse = z.infer<typeof counterpartyUpsertResponseSchema>;

// ────────────────────────────────────────────────────────────
// 料金設定（§2.2 / P5-03）
// ────────────────────────────────────────────────────────────

/** 単価の上限。**誤入力の門番**（業務上の制限ではない）。 */
export const MAX_UNIT_PRICE = 10_000_000;

/** 税率（百分率の整数）。**軽減税率の 8% と標準の 10% を想定。** */
export const taxRateSchema = z.number().int().min(0).max(100);

/**
 * 料金設定の登録（§2.2）。
 *
 * **更新の口が無い。** 値上げは行の追加（冒頭の注記）。
 * `propertyId` / `roomTypeId` / `taskType` の `null` は「その軸を問わない」。
 */
export const pricingRuleCreateRequestSchema = z
  .object({
    counterpartyId: resourceIdSchema,
    /** null = 取引先の全施設。 */
    propertyId: resourceIdSchema.nullable().default(null),
    /** null = 全客室タイプ。 */
    roomTypeId: resourceIdSchema.nullable().default(null),
    /** null = 全作業種別。 */
    taskType: z.string().max(32).nullable().default(null),
    itemCode: invoiceItemCodeSchema,
    /** 円（税抜）。**整数**（billing.md §4）。 */
    unitPrice: z.number().int().min(0).max(MAX_UNIT_PRICE),
    taxRate: taxRateSchema.default(10),
    isReducedRate: z.boolean().default(false),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    /** **小さいほうが勝つ**（§3.2）。 */
    priority: z.number().int().min(0).max(999).default(50),
  })
  .superRefine((value, ctx) => {
    if (value.validTo !== null && value.validTo < value.validFrom) {
      ctx.addIssue({ code: "custom", path: ["validTo"], message: "BEFORE_VALID_FROM" });
    }
  });

export type PricingRuleCreateRequest = z.infer<typeof pricingRuleCreateRequestSchema>;

/** 料金設定 1 件。 */
export const pricingRuleSchema = z.object({
  id: resourceIdSchema,
  counterpartyId: resourceIdSchema,
  propertyId: resourceIdSchema.nullable(),
  roomTypeId: resourceIdSchema.nullable(),
  taskType: z.string().nullable(),
  itemCode: invoiceItemCodeSchema,
  unitPrice: z.number().int(),
  taxRate: z.number().int(),
  isReducedRate: z.boolean(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  priority: z.number().int(),
});

export type PricingRuleSummary = z.infer<typeof pricingRuleSchema>;

export const pricingRuleListResponseSchema = z.object({ data: z.array(pricingRuleSchema) });

export type PricingRuleListResponse = z.infer<typeof pricingRuleListResponseSchema>;

export const pricingRuleCreateResponseSchema = z.object({ data: pricingRuleSchema });

export type PricingRuleCreateResponse = z.infer<typeof pricingRuleCreateResponseSchema>;

/**
 * 料金設定の期間を閉じる（§2.2）。
 *
 * **単価を送る欄が無い。** 送れるのは終了日だけ。値上げは行の追加で、
 * ここは「この規則を今日で終わりにする」だけを表す。
 */
export const pricingRuleCloseRequestSchema = z.object({
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type PricingRuleCloseRequest = z.infer<typeof pricingRuleCloseRequestSchema>;
