/**
 * 支払明細書 PDF に載せる値（docs/PK-SPEC-PAY.md §3.2 / P5-18 の追送）。
 *
 * task: docs/tasks/P5-18.md（作業ログ「未達（追送）」）
 *
 * ── 型をここに置く理由 ──────────────────────────────────
 * `InvoicePayload`（`invoicePayload.ts`）と同じ。**テンプレートは金額を
 * 計算しない。** 計算は `buildPayoutDraft()` と確定（PAY §3.1）で済んで
 * おり、PDF はその値を並べるだけ。
 *
 * ── 控除の項目を持たない（PAY §0.2 MUST）────────────────
 * 載るのは**支給総額の基礎**（タスク実績 × 単価 ＋ 調整行）まで。
 * 社会保険・源泉徴収の欄をこの型に足さないこと。
 *
 * ── 仕入明細書方式（PAY §3.2）────────────────────────────
 * `isContractor` が真ならテンプレートが仕入明細書方式の注記と
 * 受領者（payee）の登録番号欄を出す。文言は `PAYOUT_LABELS`
 * （`packages/pdf`）の固定文言で、payload から差し替えられない。
 */

import type { InvoiceIssuerSnapshot } from "./invoicePayload.js";
import type { PayUnitTypeValue } from "./payout.js";

/**
 * 支払を受けるスタッフ。
 *
 * **個人情報は表示名とスタッフ番号だけ**（PAY §1.1 / security.md §5。
 * 住所・口座・生年月日をこの型に足さないこと）。
 */
export interface PayoutStatementPayee {
  displayName: string;
  staffNumber: string;
  /**
   * 適格請求書発行事業者の登録番号（`T` + 13 桁）。CONTRACTOR のみ。
   * **未登録なら `null`**（行ごと出さない）。
   */
  registrationNo: string | null;
}

/** 明細 1 行（PAY §1.4 の写し）。**警告コードは紙に載せない。** */
export interface PayoutStatementLine {
  lineNo: number;
  description: string;
  /** 件数（PER_TASK）/ 分（HOURLY）/ 1（調整行）。 */
  quantity: number;
  /** TASK 行のみ。調整行は `null`（単位欄は「式」になる）。 */
  unitType: PayUnitTypeValue | null;
  unitPrice: number;
  amount: number;
}

/** 支払明細書 1 通ぶん。**この型だけで紙が組める**（DB を引き直さない）。 */
export interface PayoutStatementPayload {
  /** `PAY-{西暦}-{連番4桁}`（PAY §3.2）。 */
  documentNo: string;
  /** 発行日（確定日・`YYYY-MM-DD`）。 */
  issueDate: string;
  periodFrom: string;
  periodTo: string;
  /** 支払者（組織）。**請求書の発行事業者と同じ形**（税務プロファイル由来）。 */
  payer: InvoiceIssuerSnapshot;
  payee: PayoutStatementPayee;
  /** 真なら仕入明細書方式の注記と登録番号欄を出す（PAY §3.2）。 */
  isContractor: boolean;
  lines: PayoutStatementLine[];
  /** 支給総額の基礎（円）。**確定時に固定された値**（PAY §1.3）。 */
  totalAmount: number;
}
