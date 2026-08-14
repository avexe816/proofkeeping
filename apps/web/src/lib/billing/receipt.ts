/**
 * 領収書の発行（PK-SPEC-P5 §4.2）。
 *
 * task:  docs/tasks/P5-08.md
 * ルール: .claude/rules/billing.md §3（印紙）・§5（採番）・§6（スナップショット）
 *
 * ```
 * ① Payment を記録、Invoice を PAID に
 * ② DocumentSequencer で RCP 番号採番
 * ③ Receipt を INSERT
 * ④ PDF 生成 → R2      （Queue）
 * ⑤ メール送信          （Queue）
 * ⑥ AuditLog
 * ```
 *
 * ── 入金の表が無い（OPEN_QUESTIONS #076）────────────────
 * §4.2 の ① は「Payment を記録」と書くが、**§2 に `payment` 表が無い。**
 * 全額入金は `invoice.status = PAID` ＋ `paidAt` で表せるのでそこへ書く。
 * **一部入金は扱わない** — 金額を置く列が無く、`PARTIALLY_PAID` へ
 * 進めても「いくら入ったか」が残らない。呼び出し側が 400 で断る。
 *
 * ── 二重発行 ────────────────────────────────────────────
 * 請求書と違い、締めのような「1 期間 1 通」を保証する行が無い。
 * **`invoice.status` がその役をする。** `PAID` へ進めるのは
 * `CONFIRMED` / `SENT` / `VIEWED` / `OVERDUE` からだけなので、
 * 2 回目は 0 行更新になり、そこで止まる。
 * 請求書に紐づかない領収（前受金）は P5-08 の範囲外。
 *
 * ── 印紙貼付欄を作らない（billing.md §3）────────────────
 * `stampAmount` のような値をどこにも持たない。電子発行の注記は
 * テンプレートが定数から出す。
 */

import { determineQualifiedInvoice, fiscalYearOf } from "@pk/billing";
import {
  createReceipt,
  findCounterpartyById,
  findInvoiceById,
  findTaxProfile,
  listInvoiceTaxSummaries,
  markInvoicePaid,
  type Env,
  type PaymentMethod,
  type TenantContext,
} from "@pk/db";

import { issueDocumentNumber } from "../document/sequencer.js";

/** 発行の結果。**呼び出し側が HTTP の応答を決める。** */
export type IssueReceiptOutcome =
  | { kind: "ISSUED"; receiptId: string; documentNo: string; invoicePaid: boolean }
  | { kind: "REJECTED"; reason: IssueReceiptRejectReason };

export type IssueReceiptRejectReason =
  | "INVOICE_NOT_FOUND"
  | "INVOICE_VOIDED"
  /** 一部入金。**金額を置く列が無い**（OPEN_QUESTIONS #076）。 */
  | "PARTIAL_PAYMENT_NOT_SUPPORTED"
  | "ALREADY_PAID"
  | "COUNTERPARTY_NOT_FOUND"
  | "TAX_PROFILE_NOT_FOUND";

export interface IssueReceiptInput {
  invoiceId: string;
  receivedAmount: number;
  receivedDate: string;
  paymentMethod: PaymentMethod;
  /** 発行日（`YYYY-MM-DD`）。呼び出し側が現地時刻から出す。 */
  issueDate: string;
  /** 但し書き。省略時は §2.6 の既定。 */
  purposeText?: string;
}

/**
 * 但し書き（§8.2 の「但し 清掃業務委託料として（2026年9月分）」）。
 *
 * **対象期間を添える。** どの月の代金かが領収書だけで分かるようにする。
 */
export function purposeTextOf(periodFrom: string, periodTo: string): string {
  const month = `${periodFrom.slice(0, 4)}年${String(Number(periodFrom.slice(5, 7)))}月分`;
  // 期間が暦月をまたぐ取引先（20 日締めなど）は月名で言い切れない。
  // その場合は期間そのものを書く。
  const sameMonth = periodFrom.slice(0, 7) === periodTo.slice(0, 7);
  return sameMonth
    ? `清掃業務委託料として（${month}）`
    : `清掃業務委託料として（${periodFrom} 〜 ${periodTo}）`;
}

/**
 * 入金を記録し、領収書を 1 通発行する（§4.2 の ①〜③）。
 *
 * **PDF とメールはここで作らない。** Queue へ投げるのは呼び出し側。
 */
export async function issueReceipt(
  env: Env,
  ctx: TenantContext,
  input: IssueReceiptInput,
): Promise<IssueReceiptOutcome> {
  const invoice = await findInvoiceById(env, ctx, input.invoiceId);
  if (invoice === undefined) return { kind: "REJECTED", reason: "INVOICE_NOT_FOUND" };
  // **取り消した請求書に領収書を出さない**（§5 で赤伝が出ている）。
  if (invoice.status === "VOIDED") return { kind: "REJECTED", reason: "INVOICE_VOIDED" };

  // **一部入金を黙って全額として記録しない**（冒頭の注記）。
  if (input.receivedAmount !== invoice.totalAmount) {
    return { kind: "REJECTED", reason: "PARTIAL_PAYMENT_NOT_SUPPORTED" };
  }

  const [counterparty, taxProfile, taxSummaries] = await Promise.all([
    findCounterpartyById(env, ctx, invoice.counterpartyId),
    findTaxProfile(env, ctx),
    listInvoiceTaxSummaries(env, ctx, input.invoiceId),
  ]);
  if (counterparty === undefined) return { kind: "REJECTED", reason: "COUNTERPARTY_NOT_FOUND" };
  if (taxProfile === undefined) return { kind: "REJECTED", reason: "TAX_PROFILE_NOT_FOUND" };

  // ① 入金を記録する（`PAID` へ）。**2 回目は 0 行**（冒頭の「二重発行」）。
  const paid = await markInvoicePaid(env, ctx, input.invoiceId, ctx.now);
  if (paid === 0) return { kind: "REJECTED", reason: "ALREADY_PAID" };

  // ② 採番。**`DocumentSequencer`（DO）経由のみ**（billing.md §5）。
  const fiscalYear = fiscalYearOf(input.issueDate, taxProfile.fiscalYearStartMonth);
  const issued = await issueDocumentNumber(env, {
    organizationId: ctx.organizationId,
    documentType: "RECEIPT",
    fiscalYear,
  });

  // ③ 発行。スナップショットは請求書と同じ形（billing.md §6）。
  const { receiptId } = await createReceipt(env, ctx, {
    invoiceId: input.invoiceId,
    counterpartyId: invoice.counterpartyId,
    documentNo: issued.documentNumber,
    issueDate: input.issueDate,
    totalAmount: invoice.totalAmount,
    counterpartyName: invoice.counterpartyName,
    receivedAmount: input.receivedAmount,
    receivedDate: input.receivedDate,
    paymentMethod: input.paymentMethod,
    purposeText: input.purposeText ?? purposeTextOf(invoice.periodFrom, invoice.periodTo),
    taxSummary: taxSummaries.map((summary) => ({
      taxRate: summary.taxRate,
      isReducedRate: summary.isReducedRate,
      subtotalAmount: summary.subtotalAmount,
      taxAmount: summary.taxAmount,
      totalAmount: summary.totalAmount,
    })),
    // **発行の瞬間に決めて固定する**（billing.md §1）。
    isQualifiedInvoice: determineQualifiedInvoice(taxProfile.invoiceRegistrationNumber),
    issuerSnapshot: {
      legalName: taxProfile.legalName,
      registrationNo: taxProfile.invoiceRegistrationNumber,
      postalCode: taxProfile.postalCode,
      address: taxProfile.address,
      tel: taxProfile.tel,
    },
    counterpartySnapshot: {
      legalName: counterparty.legalName,
      postalCode: counterparty.postalCode,
      address1: counterparty.address1,
      address2: counterparty.address2,
      department: counterparty.department,
      contactName: counterparty.contactName,
      billingEmail: counterparty.billingEmail,
      ccEmails: counterparty.ccEmails,
    },
    sequence: { fiscalYear, lastNumber: issued.sequence },
  });

  return {
    kind: "ISSUED",
    receiptId,
    documentNo: issued.documentNumber,
    invoicePaid: true,
  };
}
