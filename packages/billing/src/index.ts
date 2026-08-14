/**
 * 料金計算の純粋関数。**金額はすべて整数（円）**（.claude/rules/billing.md §4）。
 *
 * **DB・fetch・環境変数・`Date.now()` を持ち込まない**（CLAUDE.md §5）。
 * 現在時刻や役務提供日は引数で受け取る。
 */

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

// 料金の解決（P5-03 / PK-SPEC-P5 §3.2 / billing.md §8）。
// **該当が無ければ `null`。** 0 を返さない（0 円と「未設定」は別）。
export {
  PRICING_STAGES,
  isEffective,
  matchStage,
  resolvePricing,
  resolveUnitPrice,
  type PricingKey,
  type PricingRuleFact,
  type PricingStage,
  type ResolvedPricing,
} from "./pricing.js";

// 税額の計算（P5-04 / 同 §3.3）。
// **端数処理は税率ごとに 1 回だけ**（同 §2.5 MUST）。
export {
  TAX_ROUNDING_MODES,
  applyRounding,
  calculateTax,
  lineAmount,
  type TaxRoundingMode,
  type TaxSummaryLine,
  type TaxTotals,
  type TaxableLine,
} from "./tax.js";

// 集計と明細の組み立て（P5-04 / 同 §3.1・§3.4）。
// **料金が決まっていないタスクを黙って落とさない**（同 §3.2 MUST）。
export {
  DEFAULT_UNIT,
  UNPRICED_TAX_RATE,
  UNPRICED_UNIT_PRICE,
  aggregateInvoiceLines,
  describeLine,
  type AggregatedLine,
  type AggregationResult,
  type BillableTask,
  type UnpricedGroup,
} from "./aggregate.js";
