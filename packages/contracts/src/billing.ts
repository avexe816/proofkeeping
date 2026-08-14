/**
 * 取引先マスタと料金設定の入出力（PK-SPEC-P5 §2.1・§2.2・§9）。
 *
 * task: docs/tasks/P5-02.md / docs/tasks/P5-03.md
 * ルール: .claude/rules/billing.md §1・§4・§8
 *
 * ── 応答に組織 ID・シャード番号を出さない ──────────────
 * architecture.md §1。`organizationId` を返さないのは他の contract と同じ。
 *
 * ── 取引先は事業者であって宿泊者ではない ────────────────
 * `billingEmail` は請求書の送付先。security.md §3 が禁じているのは
 * **宿泊者**の氏名・連絡先で、取引先（法人）の経理担当の連絡先は
 * それに当たらない。氏名の列（`contactName`）を宿泊者に使わないこと。
 */

import { z } from "zod";

import { invoiceRegistrationNumberSchema, TAX_ROUNDING_MODES } from "./property.js";
// 清掃種別は P1-05 が置いた `task.ts` の語彙をそのまま使う。**写経しない。**
import { taskTypeSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 取引先（§2.1 / P5-02）
// ────────────────────────────────────────────────────────────

/**
 * 取引先コード。組織内で一意（`uq_cp`）。
 *
 * 客室タイプのコード（`roomTypeCodeSchema`）と同じ字種にしてある。
 * 会計ソフトへの書き出しでカンマが列を割らないため。
 */
export const counterpartyCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

/** 締め日（1〜31）。**31 は月末の意味**（schema の注記）。 */
export const closingDaySchema = z.number().int().min(1).max(31);

/** 支払サイト（日数）。0 は即日。1 年を超える設定は打ち間違いとして弾く。 */
export const paymentTermDaysSchema = z.number().int().min(0).max(365);

/**
 * 登録番号。**空文字を `null` に落とす。**
 *
 * 未設定なら適格請求書ではない（§1.1 MUST）。`""` のまま保存すると
 * 「設定済みだが空」という第 3 の状態ができ、`isQualifiedInvoice` の
 * 判定が濁る。`organizationSettingsUpdateSchema` と同じ形。
 */
const optionalRegistrationNo = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.union([z.null(), invoiceRegistrationNumberSchema]));

/** 空文字を `null` に落とす任意のテキスト。 */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable();
}

/**
 * CC の宛先（§2.1 の `ccEmails`）。
 *
 * **10 件まで。** 送付ログ（`documentDelivery.ccEmails`）にそのまま載り、
 * 上限が無いと 1 通の請求書で送信先が際限なく増える。
 */
const ccEmailsSchema = z.array(z.email().trim()).max(10);

/** 取引先の作成（`POST /api/v1/counterparties`）。 */
export const counterpartyCreateSchema = z.object({
  code: counterpartyCodeSchema,
  legalName: z.string().trim().min(1).max(120),
  displayName: optionalText(120).optional(),
  invoiceRegistrationNo: optionalRegistrationNo.optional(),
  postalCode: optionalText(8).optional(),
  address1: optionalText(120).optional(),
  address2: optionalText(120).optional(),
  department: optionalText(60).optional(),
  contactName: optionalText(60).optional(),
  billingEmail: z.email().trim(),
  ccEmails: ccEmailsSchema.optional(),
  closingDay: closingDaySchema.optional(),
  paymentTermDays: paymentTermDaysSchema.optional(),
  taxRoundingMode: z.enum(TAX_ROUNDING_MODES).optional(),
});

export type CounterpartyCreate = z.infer<typeof counterpartyCreateSchema>;

/**
 * 取引先の更新（`PATCH /api/v1/counterparties/:id`）。
 *
 * **`code` を含めない。** 料金設定と月次締めがこの取引先を指しており、
 * 鍵を付け替えると過去の設定が別の相手を指す（`roomTypeUpdateSchema` と
 * 同じ判断）。無効化は `isActive: false`。**削除の口は無い**（CLAUDE.md §4）。
 */
export const counterpartyUpdateSchema = z.object({
  legalName: z.string().trim().min(1).max(120).optional(),
  displayName: optionalText(120).optional(),
  invoiceRegistrationNo: optionalRegistrationNo.optional(),
  postalCode: optionalText(8).optional(),
  address1: optionalText(120).optional(),
  address2: optionalText(120).optional(),
  department: optionalText(60).optional(),
  contactName: optionalText(60).optional(),
  billingEmail: z.email().trim().optional(),
  ccEmails: ccEmailsSchema.optional(),
  closingDay: closingDaySchema.optional(),
  paymentTermDays: paymentTermDaysSchema.optional(),
  taxRoundingMode: z.enum(TAX_ROUNDING_MODES).optional(),
  isActive: z.boolean().optional(),
});

export type CounterpartyUpdate = z.infer<typeof counterpartyUpdateSchema>;

/** 一覧の 1 件。**`organizationId` を含めない。** */
export const counterpartySummarySchema = z.object({
  counterpartyId: z.string().min(1),
  code: z.string().min(1),
  legalName: z.string().min(1),
  displayName: z.string().nullable(),
  /**
   * 取引先の登録番号。
   *
   * **交付を受ける側の登録番号は §1.1 の 6 要件に入っていない**（6 番は
   * 名称のみ）。それでも持つのは、取引先の控除の可否を画面で確かめられる
   * ようにするため。請求書の `isQualifiedInvoice` は**発行元**の登録番号
   * （`organizationTaxProfile`）で決まる。混同しないこと。
   */
  invoiceRegistrationNo: z.string().nullable(),
  postalCode: z.string().nullable(),
  address1: z.string().nullable(),
  address2: z.string().nullable(),
  department: z.string().nullable(),
  contactName: z.string().nullable(),
  billingEmail: z.string().min(1),
  ccEmails: z.array(z.string()),
  closingDay: z.number().int(),
  paymentTermDays: z.number().int(),
  taxRoundingMode: z.enum(TAX_ROUNDING_MODES),
  isActive: z.boolean(),
});

export type CounterpartySummary = z.infer<typeof counterpartySummarySchema>;

/** `GET /api/v1/counterparties` の応答。 */
export const counterpartyListResponseSchema = z.object({
  data: z.array(counterpartySummarySchema),
});

export type CounterpartyListResponse = z.infer<typeof counterpartyListResponseSchema>;

// ────────────────────────────────────────────────────────────
// 料金設定（§2.2 / P5-03）
// ────────────────────────────────────────────────────────────

/** 品目コード（§2.4）。`packages/db` の `INVOICE_ITEM_CODES` と同じ語彙。 */
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

/**
 * 税率（百分率の整数）。**10 と 8 のみ。**
 *
 * 自由入力にしない。税率が増えるのは制度が変わったときで、そのときは
 * 帳票テンプレート（§8.1）と税区分サマリーの並びも一緒に見直す。
 */
export const taxRateSchema = z.union([z.literal(10), z.literal(8)]);

/** 単価（円・税抜）。**整数**（billing.md §4）。負の単価は赤伝の側で表す。 */
export const unitPriceSchema = z.number().int().min(0).max(10_000_000);

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 料金設定の登録（`POST /api/v1/pricing-rules`）。
 *
 * ── null は「すべて」──────────────────────────────────
 * `propertyId` / `roomTypeId` / `taskType` を省くと、その軸を問わない
 * 行になる（§2.2）。どれを埋めるかで §3.2 の 5 段のどこに載るかが決まる。
 * **梯子に載らない組み合わせは API が 400 で断る**（docs/DECISIONS.md #123）。
 * 形の検査は `packages/billing` の `pricingRuleStage()` が行い、ここでは
 * しない（判定を 2 か所に置かない）。
 *
 * ── 更新の口が無い ──────────────────────────────────────
 * 値上げは行の追加。既存の行の単価を書き換えると、過去の請求書の根拠が
 * 変わる。終了は `PATCH /:id`（`validTo` を入れて期間を閉じるだけ）。
 */
export const pricingRuleCreateSchema = z.object({
  counterpartyId: z.string().min(1),
  propertyId: z.string().min(1).nullable().optional(),
  roomTypeId: z.string().min(1).nullable().optional(),
  taskType: taskTypeSchema.nullable().optional(),
  itemCode: z.enum(INVOICE_ITEM_CODES),
  unitPrice: unitPriceSchema,
  taxRate: taxRateSchema.optional(),
  isReducedRate: z.boolean().optional(),
  validFrom: isoDateSchema,
  validTo: isoDateSchema.nullable().optional(),
  priority: z.number().int().min(0).max(999).optional(),
});

export type PricingRuleCreate = z.infer<typeof pricingRuleCreateSchema>;

/**
 * 料金設定の期間を閉じる（`PATCH /api/v1/pricing-rules/:id`）。
 *
 * **`validTo` しか受けない。** 単価・対象・税率を変える口を作らない。
 */
export const pricingRuleCloseSchema = z.object({
  validTo: isoDateSchema,
});

export type PricingRuleClose = z.infer<typeof pricingRuleCloseSchema>;

/** 一覧の 1 件。**`organizationId` を含めない。** */
export const pricingRuleSummarySchema = z.object({
  pricingRuleId: z.string().min(1),
  counterpartyId: z.string().min(1),
  propertyId: z.string().nullable(),
  roomTypeId: z.string().nullable(),
  taskType: z.string().nullable(),
  itemCode: z.enum(INVOICE_ITEM_CODES),
  unitPrice: z.number().int(),
  taxRate: z.number().int(),
  isReducedRate: z.boolean(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  priority: z.number().int(),
  /**
   * §3.2 のどの段に載るか（1〜5）。**画面が「なぜこの行が勝つか」を出せる。**
   * 梯子に載らない形は `null`。登録時に断っているので既存行では出ないが、
   * 仕様が変わったときに古い行を見つけられるよう応答には残す。
   */
  stage: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).nullable(),
});

export type PricingRuleSummary = z.infer<typeof pricingRuleSummarySchema>;

/** `GET /api/v1/pricing-rules?counterpartyId=` の応答。 */
export const pricingRuleListResponseSchema = z.object({
  counterpartyId: z.string().min(1),
  data: z.array(pricingRuleSummarySchema),
});

export type PricingRuleListResponse = z.infer<typeof pricingRuleListResponseSchema>;

// ────────────────────────────────────────────────────────────
// 月次締め（P5-05 / PK-SPEC-P5 §2.8・§6.1・§9）
// ────────────────────────────────────────────────────────────

/** 月次締めの状態（§2.8）。`packages/db` の `BILLING_PERIOD_STATUSES` と同じ。 */
export const BILLING_PERIOD_STATUSES = [
  "OPEN",
  "REVIEWING",
  "AGREED",
  "INVOICED",
  "CLOSED",
] as const;

/**
 * 一覧の 1 件。**`organizationId` を含めない**（組織 ID を応答に出さない）。
 *
 * **金額を含めない。** §2.8 に金額の列は無く、集計はそのつど
 * `buildInvoiceDraft()` が出す（docs/DECISIONS.md #124）。締めの一覧に
 * 数字を載せるのは明細を組み立てる画面（P5-12）の仕事で、
 * ここに合計を足すと「いつ集計した数字か」が説明できなくなる。
 */
export const billingPeriodSummarySchema = z.object({
  billingPeriodId: z.string().min(1),
  counterpartyId: z.string().min(1),
  periodFrom: isoDateSchema,
  periodTo: isoDateSchema,
  status: z.enum(BILLING_PERIOD_STATUSES),
  /** 集計バッチが通った時刻（ISO 8601 UTC）。未集計なら `null`。 */
  aggregatedAt: z.string().nullable(),
  agreedAt: z.string().nullable(),
  agreedByCounterparty: z.boolean(),
  /** 発行済みの請求書。**未発行なら `null`。** */
  invoiceId: z.string().nullable(),
});

export type BillingPeriodSummary = z.infer<typeof billingPeriodSummarySchema>;

/** `GET /api/v1/billing-periods?counterpartyId=&status=` の応答。 */
export const billingPeriodListResponseSchema = z.object({
  data: z.array(billingPeriodSummarySchema),
});

export type BillingPeriodListResponse = z.infer<typeof billingPeriodListResponseSchema>;

// ────────────────────────────────────────────────────────────
// 請求書の発行と一覧（P5-07 / PK-SPEC-P5 §4.1・§9）
// ────────────────────────────────────────────────────────────

/** 請求書の状態（§2.3）。`packages/db` の `INVOICE_STATUSES` と同じ。 */
export const INVOICE_STATUSES = [
  "DRAFT",
  "CONFIRMED",
  "SENT",
  "VIEWED",
  "PAID",
  "PARTIALLY_PAID",
  "OVERDUE",
  "VOIDED",
] as const;

/**
 * `POST /api/v1/invoices/issue-and-send` の入力。
 *
 * **締めの ID だけ。** 金額・明細・期間をリクエストで受け取らない
 * （§4.1 は締めから組み立てると定める）。人が金額を差し込める口を
 * 作ると、請求根拠が証跡から切れる（§6.3 の意味が無くなる）。
 */
export const invoiceIssueRequestSchema = z.object({
  billingPeriodId: z.string().min(1),
});

export type InvoiceIssueRequest = z.infer<typeof invoiceIssueRequestSchema>;

/** 一覧の 1 件。**`organizationId` と R2 のキーを含めない。** */
export const invoiceSummarySchema = z.object({
  invoiceId: z.string().min(1),
  counterpartyId: z.string().min(1),
  documentNo: z.string().min(1),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
  periodFrom: isoDateSchema,
  periodTo: isoDateSchema,
  counterpartyName: z.string().min(1),
  subtotalAmount: z.number().int(),
  taxAmount: z.number().int(),
  totalAmount: z.number().int(),
  isQualifiedInvoice: z.boolean(),
  isCreditNote: z.boolean(),
  status: z.enum(INVOICE_STATUSES),
  /** PDF ができているか。**R2 のキーそのものを返さない。** */
  hasPdf: z.boolean(),
  sentAt: z.string().nullable(),
});

export type InvoiceSummary = z.infer<typeof invoiceSummarySchema>;

/** 明細 1 行。**税額の列を持たない**（§2.5 MUST）。 */
export const invoiceLineSchema = z.object({
  lineNo: z.number().int().min(1),
  propertyId: z.string().nullable(),
  itemCode: z.enum(INVOICE_ITEM_CODES),
  description: z.string(),
  serviceDateFrom: z.string().nullable(),
  serviceDateTo: z.string().nullable(),
  quantity: z.number(),
  unit: z.string(),
  unitPrice: z.number().int(),
  amount: z.number().int(),
  taxRate: z.number().int(),
  isReducedRate: z.boolean(),
  /**
   * 集計元のタスク（§6.3 のドリルダウン）。
   *
   * **ここが ProofKeeping の請求機能の核心。** 明細から証跡へ辿れる。
   * P5-13 がこの ID を使って W-07（証跡）へ繋ぐ。
   */
  taskIds: z.array(z.string()),
});

export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/** 税区分サマリー 1 行（§2.5）。 */
export const invoiceTaxSummarySchema = z.object({
  taxRate: z.number().int(),
  isReducedRate: z.boolean(),
  subtotalAmount: z.number().int(),
  taxAmount: z.number().int(),
  totalAmount: z.number().int(),
});

export type InvoiceTaxSummary = z.infer<typeof invoiceTaxSummarySchema>;

/** `GET /api/v1/invoices/:id` の応答。 */
export const invoiceDetailResponseSchema = invoiceSummarySchema.extend({
  lines: z.array(invoiceLineSchema),
  taxSummaries: z.array(invoiceTaxSummarySchema),
});

export type InvoiceDetailResponse = z.infer<typeof invoiceDetailResponseSchema>;

/** `GET /api/v1/invoices` の応答。 */
export const invoiceListResponseSchema = z.object({
  data: z.array(invoiceSummarySchema),
});

export type InvoiceListResponse = z.infer<typeof invoiceListResponseSchema>;

// ────────────────────────────────────────────────────────────
// 領収書と入金（P5-08 / PK-SPEC-P5 §4.2・§9）
// ────────────────────────────────────────────────────────────

/** 入金方法（§2.6）。`packages/db` の `PAYMENT_METHODS` と同じ。 */
export const PAYMENT_METHODS = ["BANK_TRANSFER", "CASH", "CARD", "OTHER"] as const;

/** 領収書の状態（§2.6）。 */
export const RECEIPT_STATUSES = ["ISSUED", "SENT", "VOIDED"] as const;

/**
 * `POST /api/v1/receipts/issue-and-send` の入力（§4.2）。
 *
 * **`receivedAmount` を受け取るのは「いくら入ったか」が事実だから。**
 * ただし請求額と一致しない場合は 409 で断る（一部入金を置く列が
 * 無い / docs/OPEN_QUESTIONS.md #076）。黙って全額として記録しない。
 */
export const receiptIssueRequestSchema = z.object({
  invoiceId: z.string().min(1),
  receivedAmount: z.number().int(),
  receivedDate: isoDateSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** 但し書き。省略時は請求書の対象期間から組み立てる。 */
  purposeText: z.string().trim().min(1).max(120).optional(),
});

export type ReceiptIssueRequest = z.infer<typeof receiptIssueRequestSchema>;

/** 一覧の 1 件。**`organizationId` と R2 のキーを含めない。** */
export const receiptSummarySchema = z.object({
  receiptId: z.string().min(1),
  invoiceId: z.string().nullable(),
  counterpartyId: z.string().min(1),
  documentNo: z.string().min(1),
  issueDate: isoDateSchema,
  counterpartyName: z.string().min(1),
  receivedAmount: z.number().int(),
  receivedDate: isoDateSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  totalAmount: z.number().int(),
  isQualifiedInvoice: z.boolean(),
  status: z.enum(RECEIPT_STATUSES),
  hasPdf: z.boolean(),
  sentAt: z.string().nullable(),
});

export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;

/** `GET /api/v1/receipts` の応答。**検索 3 項目は請求書と同じ。** */
export const receiptListResponseSchema = z.object({
  data: z.array(receiptSummarySchema),
});

export type ReceiptListResponse = z.infer<typeof receiptListResponseSchema>;
