/**
 * 請求まわりの語彙。**`packages/db` に依存させない**（CLAUDE.md §5）。
 *
 * task: docs/tasks/P5-03.md / docs/tasks/P5-04.md
 * 仕様: docs/PK-SPEC-P5.md §2.2・§2.4
 *
 * `packages/engine` の `TASK_TYPE_VALUES`（taskGeneration.ts）と同じ扱いで、
 * schema の語彙を**写しているが import はしない。** 純粋関数の側から
 * D1 のスキーマへ辺を張ると、この package の「依存ゼロ」が崩れる。
 * 一致は `vocabulary.spec.ts` が固定する（片側だけ増えたら落ちる）。
 */

/** 清掃種別。`packages/db` の `TASK_TYPES` と同じ語彙（依存はさせない）。 */
export const TASK_TYPE_VALUES = [
  "CHECKOUT",
  "STAYOVER",
  "DEEP",
  "COMMON_AREA",
  "RECHECK",
] as const;

export type BillableTaskType = (typeof TASK_TYPE_VALUES)[number];

/** 品目コード（§2.4）。`packages/db` の `INVOICE_ITEM_CODES` と同じ語彙。 */
export const INVOICE_ITEM_CODE_VALUES = [
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

export type InvoiceItemCodeValue = (typeof INVOICE_ITEM_CODE_VALUES)[number];

/** 端数処理方式（billing.md §4）。`packages/db` の `TAX_ROUNDING_MODES` と同じ。 */
export const TAX_ROUNDING_MODE_VALUES = ["FLOOR", "CEIL", "ROUND"] as const;

export type TaxRoundingModeValue = (typeof TAX_ROUNDING_MODE_VALUES)[number];

/**
 * 清掃種別 → 品目コード（§2.4 の表）。
 *
 * ── `RECHECK` がここに無いのは意図的 ────────────────────
 * §2.4 の品目コードは 10 個で、**再確認に対応する行が無い。**
 * 近い名前へ寄せる（`CLEAN_CHECKOUT` にする、`EXTRA_REQUEST` にする）のは
 * 推測で、金額の根拠が説明できなくなる（CLAUDE.md §1-4）。
 *
 * かわりに §3.2 MUST「該当する料金設定がないタスクを黙って落とさない」と
 * 同じ扱いにする。`buildInvoiceDraft()` は品目が引けないタスクを
 * `ADJUSTMENT` の **¥0 明細＋警告**として計上する。請求から消えない。
 * docs/OPEN_QUESTIONS.md #069。
 */
export const ITEM_CODE_BY_TASK_TYPE: Readonly<
  Partial<Record<BillableTaskType, InvoiceItemCodeValue>>
> = {
  CHECKOUT: "CLEAN_CHECKOUT",
  STAYOVER: "CLEAN_STAYOVER",
  DEEP: "CLEAN_DEEP",
  COMMON_AREA: "CLEAN_COMMON",
};

/**
 * 明細の表示名（§3.4 の例が「アウト清掃」「滞在清掃」と書く）。
 *
 * **UI 文言ではない。** 帳票に固定される取引内容（適格請求書の
 * 6 要件のうち §1.1 の 3 番）で、発行後に翻訳し直してはならない。
 * i18n キーにしないのはそのため（ui-writing.md §1 は JSX の規則）。
 */
export const TASK_TYPE_LABELS: Readonly<Record<BillableTaskType, string>> = {
  CHECKOUT: "アウト清掃",
  STAYOVER: "滞在清掃",
  DEEP: "特別清掃",
  COMMON_AREA: "共用部清掃",
  RECHECK: "再確認",
};

/** 品目コードの表示名（§2.4 の表）。 */
export const ITEM_CODE_LABELS: Readonly<Record<InvoiceItemCodeValue, string>> = {
  CLEAN_CHECKOUT: "アウト清掃",
  CLEAN_STAYOVER: "滞在清掃",
  CLEAN_DEEP: "特別清掃",
  CLEAN_COMMON: "共用部清掃",
  REWORK: "再清掃",
  LINEN_DAMAGE: "リネン破損弁償",
  EXTRA_REQUEST: "追加依頼作業",
  LATE_CHECKOUT: "レイトチェックアウト対応",
  HOLIDAY_SURCHARGE: "繁忙期割増",
  ADJUSTMENT: "調整",
};

/** 入金方法（§2.6）。`packages/db` の `PAYMENT_METHODS` と同じ語彙。 */
export const PAYMENT_METHOD_VALUES = ["BANK_TRANSFER", "CASH", "CARD", "OTHER"] as const;

export type PaymentMethodValue = (typeof PAYMENT_METHOD_VALUES)[number];

/**
 * 入金方法の表示名（§8.2 の「お支払方法 銀行振込」）。
 *
 * **UI 文言ではない。** 発行時に領収書へ固定される取引の事実で、
 * 発行後に翻訳し直してはならない（`TASK_TYPE_LABELS` と同じ扱い。
 * ui-writing.md §1 は JSX の規則）。
 */
export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethodValue, string>> = {
  BANK_TRANSFER: "銀行振込",
  CASH: "現金",
  CARD: "クレジットカード",
  OTHER: "その他",
};
