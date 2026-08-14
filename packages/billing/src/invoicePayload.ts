/**
 * 請求書 PDF に載せる値（PK-SPEC-P5 §8.1 / .claude/rules/billing.md §1）。
 *
 * task: docs/tasks/P5-06.md
 *
 * ── なぜ型をここに置くのか ──────────────────────────────
 * `packages/pdf` が `@pk/engine` の `DailyReportPayload` を読むのと同じ形。
 * **テンプレートは金額を計算しない**（`dailyReport.ts` の「数値を
 * 再計算しない」）。計算は `buildInvoiceDraft()` と発行時の確定
 * （§4.1 の ③〜⑥）で済んでおり、PDF はその値を並べるだけ。
 * 型を純粋関数の側に置くと、**紙に載る値の出どころが 1 か所**になる。
 *
 * ── スナップショットを渡す（マスタを渡さない）───────────
 * `issuer` / `counterparty` は**発行時に固定した値**（§4.1 の ④ /
 * billing.md §6）。取引先マスタを引き直して描くと、住所を直した
 * 瞬間に過去の請求書の見た目が変わる。**この payload に
 * `counterpartyId` を持たせていない**のはそのため。
 *
 * ── 適格請求書の 6 要件（§1.1）がどこに載るか ───────────
 * ```
 * 1 発行事業者の氏名・名称と登録番号   issuer.legalName / issuer.registrationNo
 * 2 取引年月日                          issueDate と各明細の serviceDate
 * 3 取引内容（軽減税率なら明示）        lines[].description / lines[].isReducedRate
 * 4 税率ごとの対価の合計額と適用税率    taxSummaries[]
 * 5 税率ごとの消費税額等                taxSummaries[].taxAmount
 * 6 交付を受ける事業者の氏名・名称      counterparty.legalName
 * ```
 * **どれかが欠けた payload を作れないように、すべて必須にしてある。**
 * 登録番号だけは `null` を取りうる（未取得の組織がある）。その場合は
 * `isQualifiedInvoice = false` で、テンプレートが但し書きを出す。
 */

import type { TaxSummaryEntry } from "./tax.js";

/** 発行事業者（§1.1 の 1 番）。**発行時のスナップショット。** */
export interface InvoiceIssuerSnapshot {
  legalName: string;
  /** `T` + 13 桁。**未取得なら `null`**（適格請求書にならない）。 */
  registrationNo: string | null;
  postalCode: string | null;
  address: string | null;
  tel: string | null;
}

/** 交付を受ける事業者（§1.1 の 6 番）。**発行時のスナップショット。** */
export interface InvoiceCounterpartySnapshot {
  legalName: string;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  department: string | null;
  contactName: string | null;
}

/** 明細 1 行（§2.4 の部分集合）。**税額の列を持たない**（§2.5 MUST）。 */
export interface InvoicePayloadLine {
  lineNo: number;
  description: string;
  serviceDateFrom: string | null;
  serviceDateTo: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  taxRate: number;
  isReducedRate: boolean;
}

/** 請求書 1 通ぶん。**この型だけで紙が組める**（DB を引き直さない）。 */
export interface InvoicePayload {
  documentNo: string;
  /** `YYYY-MM-DD`。 */
  issueDate: string;
  dueDate: string;
  periodFrom: string;
  periodTo: string;
  /**
   * 適格請求書か（billing.md §1）。
   * **偽ならテンプレートが「適格請求書ではありません」を出す。**
   */
  isQualifiedInvoice: boolean;
  /** 赤伝（マイナス伝票 / §5）。真なら金額が負で、表題に「訂正」が付く。 */
  isCreditNote: boolean;
  issuer: InvoiceIssuerSnapshot;
  counterparty: InvoiceCounterpartySnapshot;
  lines: InvoicePayloadLine[];
  /** 税率ごとに 1 行（§2.5）。**税率の高い順。** */
  taxSummaries: TaxSummaryEntry[];
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
  /**
   * 振込先（§8.1 の「お振込先」）。
   *
   * **対応する列がまだ無い**（`organizationTaxProfile` は登録番号・住所・
   * 電話までで、口座を持たない）。docs/OPEN_QUESTIONS.md #073。
   * `null` のときテンプレートはその節ごと出さない。**空欄の枠を
   * 出さないこと** — 振込先の空欄が載った請求書は事故になる。
   */
  bankAccountText: string | null;
  note: string | null;
}

/**
 * 登録番号の形（`T` + 13 桁 / billing.md §1）。
 *
 * **`isQualifiedInvoice` をここで決め直さない。** 帳票の
 * `isQualifiedInvoice` は**発行時に固定した事実**で、あとから
 * マスタに登録番号が入っても過去の請求書は適格にならない
 * （billing.md §6）。この関数は発行の瞬間に 1 度だけ使う。
 */
export function isValidRegistrationNo(value: string | null): value is string {
  return value !== null && /^T\d{13}$/.test(value);
}

/**
 * 発行の瞬間に「適格請求書か」を決める（§1.1 MUST）。
 *
 * 登録番号が未設定・形が違うなら偽。**発行時にだけ呼び、結果を
 * `invoice.isQualifiedInvoice` に固定する**（P5-07）。
 */
export function determineQualifiedInvoice(registrationNo: string | null): boolean {
  return isValidRegistrationNo(registrationNo);
}
