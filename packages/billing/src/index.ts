// 料金計算の純粋関数。金額はすべて整数（円）。
// DB・fetch・環境変数・Date.now を持ち込まない（CLAUDE.md §5）。

// 書類番号の書式と会計年度の判定（P0-17）。採番そのものは
// DocumentSequencer（Durable Object）が行う。
export {
  DOCUMENT_NUMBER_DIGITS,
  DOCUMENT_NUMBER_PREFIXES,
  DOCUMENT_TYPES,
  documentSequencerName,
  fiscalYearOf,
  formatDocumentNumber,
  type DocumentType,
} from "./documentNumber.js";

// 請求まわりの語彙（P5-03 / P5-04）。`packages/db` の schema と同じ値を
// 持つが依存はさせない。一致は vocabulary.spec.ts が固定する。
export {
  INVOICE_ITEM_CODE_VALUES,
  ITEM_CODE_BY_TASK_TYPE,
  ITEM_CODE_LABELS,
  TASK_TYPE_LABELS,
  TASK_TYPE_VALUES,
  TAX_ROUNDING_MODE_VALUES,
  type BillableTaskType,
  type InvoiceItemCodeValue,
  type TaxRoundingModeValue,
} from "./vocabulary.js";

// 料金の解決（P5-03 / PK-SPEC-P5 §3.2）。5 段階の優先順位。
export {
  isEffectiveOn,
  pricingRuleStage,
  resolvePricingRule,
  type PricingQuery,
  type PricingResolution,
  type PricingRuleCandidate,
  type PricingStage,
} from "./pricing.js";

// 消費税（P5-04 / 同 §3.3）。端数処理は税率ごとに 1 回だけ。
export {
  calcLineAmount,
  calcTaxAmount,
  summarizeTax,
  type TaxBucketKey,
  type TaxSummaryEntry,
  type TaxableLine,
} from "./tax.js";

// 集計と請求書ドラフト（P5-04 / 同 §3）。単価未設定は ¥0 明細＋警告。
export {
  BILLING_WARNING_CODES,
  buildInvoiceDraft,
  type BillableTask,
  type BillingWarning,
  type BillingWarningCode,
  type BuildInvoiceDraftInput,
  type DraftInvoiceLine,
  type InvoiceDraft,
} from "./aggregate.js";
