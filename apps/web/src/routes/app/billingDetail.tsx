/**
 * W-12 契約と請求 — 請求書の明細と入金の記録。
 *
 *   /app/billing/:invoiceId
 *
 * 経緯:  人間の指示 2026-08-17（銀行振込前提）。
 * 参照:  ui-prototypes/owner/pkown-v3-D-billing-settings-perm.html（10）
 * ルール: .claude/rules/billing.md / security.md §6（帳票の発行は監査ログ）
 *
 * ── 構成はプロトタイプの 10 ─────────────────────────────
 * KPI（清掃件数 → 金額 → 支払期限 → 状態。**金額より件数が先** —
 * 根拠を先に見せる、というプロトタイプの確定事項）、内訳、契約の内容。
 *
 * ── 入金の記録 = 領収書の発行（P5-08 の①〜⑥そのまま）────
 * `issueReceipt()` が入金の記録（`invoice.status = PAID`）と領収書の
 * 発行を 1 つの流れで行う。**この画面は API
 * （`/api/v1/receipts/issue-and-send`）と同じ lib を呼ぶ**だけで、
 * 別の実装を持たない。全額入金のみ（一部入金は金額を置く列が無い /
 * OPEN_QUESTIONS #076）。金額の入力欄を置かないのは、請求額と違う額を
 * 手で打てると消込のつもりが別金額の領収書になるため。
 *
 * ── 単価は表示専用 ──────────────────────────────────────
 * プロトタイプの確定事項。「単価の変更は契約手続き」= 取引先と料金の
 * 画面（W-18）で行い、ここから変えられない。
 */

import {
  findCounterpartyById,
  findInvoiceById,
  findTaxProfile,
  listInvoiceLines,
  listInvoiceTaxSummaries,
  listPricingRules,
  NotFoundError,
  recordAudit,
  type InvoiceStatus,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission, can } from "../../lib/auth/permission.js";
import {
  enqueueReceiptDelivery,
  enqueueReceiptPdf,
} from "../../lib/billing/deliverReceipt.js";
import { INVOICE_STATUS_LABEL, formatYenAmount } from "../../lib/billing/labels.js";
import { issueReceipt } from "../../lib/billing/receipt.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface LineRow {
  lineNo: number;
  description: string;
  unitPrice: number;
  quantity: number;
  unit: string;
  amount: number;
}

interface TaxRow {
  taxRate: number;
  subtotalAmount: number;
  taxAmount: number;
}

interface PriceRow {
  itemCode: string;
  unitPrice: number;
  validFrom: string;
  validTo: string | null;
}

interface BillingDetailData {
  invoice: {
    id: string;
    documentNo: string;
    periodFrom: string;
    periodTo: string;
    issueDate: string;
    dueDate: string;
    counterpartyName: string;
    subtotalAmount: number;
    taxAmount: number;
    totalAmount: number;
    status: InvoiceStatus;
    paidDate: string | null;
    isCreditNote: boolean;
    isQualifiedInvoice: boolean;
  };
  /** 単位が「室」の明細の数量合計（プロトタイプの KPI 1 枚目）。 */
  cleaningCount: number;
  lines: LineRow[];
  taxes: TaxRow[];
  counterparty: {
    name: string;
    closingDay: number;
    paymentTermDays: number;
  } | null;
  prices: PriceRow[];
  canRecordPayment: boolean;
}

/** 入金を記録できる状態（`markInvoicePaid()` の集合と同じ）。 */
const PAYABLE_STATUSES: readonly InvoiceStatus[] = ["CONFIRMED", "SENT", "VIEWED", "OVERDUE"];

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<BillingDetailData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  assertPermission(tenant, "billing.readInternal", ORGANIZATION_TARGET);

  const invoiceId = params["invoiceId"];
  if (invoiceId === undefined) throw new NotFoundError();

  const invoice = await findInvoiceById(env, tenant, invoiceId);
  if (invoice === undefined) throw new NotFoundError();

  const [lines, taxes, counterparty, prices] = await Promise.all([
    listInvoiceLines(env, tenant, invoiceId),
    listInvoiceTaxSummaries(env, tenant, invoiceId),
    findCounterpartyById(env, tenant, invoice.counterpartyId),
    listPricingRules(env, tenant, { counterpartyId: invoice.counterpartyId }),
  ]);

  return {
    invoice: {
      id: invoice.id,
      documentNo: invoice.documentNo,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      counterpartyName: invoice.counterpartyName,
      subtotalAmount: invoice.subtotalAmount,
      taxAmount: invoice.taxAmount,
      totalAmount: invoice.totalAmount,
      status: invoice.status,
      paidDate: invoice.paidAt === null ? null : invoice.paidAt.toISOString().slice(0, 10),
      isCreditNote: invoice.isCreditNote,
      isQualifiedInvoice: invoice.isQualifiedInvoice,
    },
    cleaningCount: lines
      .filter((line) => line.unit === "室")
      .reduce((sum, line) => sum + line.quantity, 0),
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      unit: line.unit,
      amount: line.amount,
    })),
    taxes: taxes.map((tax) => ({
      taxRate: tax.taxRate,
      subtotalAmount: tax.subtotalAmount,
      taxAmount: tax.taxAmount,
    })),
    counterparty:
      counterparty === undefined
        ? null
        : {
            name: counterparty.displayName ?? counterparty.legalName,
            closingDay: counterparty.closingDay,
            paymentTermDays: counterparty.paymentTermDays,
          },
    prices: prices.map((rule) => ({
      itemCode: rule.itemCode,
      unitPrice: rule.unitPrice,
      validFrom: rule.validFrom,
      validTo: rule.validTo,
    })),
    canRecordPayment:
      can(tenant, "billing.write", ORGANIZATION_TARGET) &&
      !invoice.isCreditNote &&
      PAYABLE_STATUSES.includes(invoice.status),
  };
}

type PaymentFailure =
  | "INVALID"
  | "ALREADY_PAID"
  | "NOT_PAYABLE";

interface BillingDetailActionResult {
  paid?: boolean;
  documentNo?: string;
  failure?: PaymentFailure;
}

/** `YYYY-MM-DD`（過去〜当日）。振込は着金日を記録する。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 当日の日付（JST）。`/api/v1/receipts` の `todayInJst()` と同じ。 */
function todayInJst(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export async function action({
  request,
  params,
  context,
}: ActionFunctionArgs): Promise<BillingDetailActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  assertPermission(tenant, "billing.write", ORGANIZATION_TARGET);

  const invoiceId = params["invoiceId"];
  if (invoiceId === undefined) throw new NotFoundError();

  const invoice = await findInvoiceById(env, tenant, invoiceId);
  if (invoice === undefined) throw new NotFoundError();

  const form = await request.formData();
  const receivedDate = form.get("receivedDate");
  if (typeof receivedDate !== "string" || !DATE_PATTERN.test(receivedDate)) {
    return { failure: "INVALID" };
  }

  // API（/api/v1/receipts/issue-and-send）と同じ流れ。**別実装を持たない。**
  // 全額入金のみ・振込固定（この画面の前提。他の方法は API から）。
  const outcome = await issueReceipt(env, tenant, {
    invoiceId,
    receivedAmount: invoice.totalAmount,
    receivedDate,
    paymentMethod: "BANK_TRANSFER",
    issueDate: todayInJst(now),
  });

  if (outcome.kind === "REJECTED") {
    if (outcome.reason === "ALREADY_PAID") return { failure: "ALREADY_PAID" };
    return { failure: "NOT_PAYABLE" };
  }

  const taxProfile = await findTaxProfile(env, tenant);
  // PDF → 送付。**どちらも Queue**（billing.md §7。失敗しても領収書は残る）。
  await enqueueReceiptPdf(env, tenant, {
    receiptId: outcome.receiptId,
    sealImageKey: taxProfile?.sealImageKey ?? null,
  });
  await enqueueReceiptDelivery(env, tenant, {
    receiptId: outcome.receiptId,
    sentById: session.membershipId,
  });

  // security.md §6「帳票の発行」。
  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "document.issued",
    targetType: "receipt",
    targetId: outcome.receiptId,
    after: {
      documentNo: outcome.documentNo,
      receivedAmount: invoice.totalAmount,
      paymentMethod: "BANK_TRANSFER",
      invoiceId,
    },
    ip: request.headers.get("CF-Connecting-IP") ?? undefined,
  });

  return { paid: true, documentNo: outcome.documentNo };
}

export default function BillingDetail() {
  const data = useLoaderData<BillingDetailData>();
  const result = useActionData<BillingDetailActionResult>();
  const { invoice } = data;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{`${t("billing.title")} ${invoice.documentNo}`}</h1>
      </div>
      <p className="pk-muted">
        {`${invoice.counterpartyName} · ${invoice.periodFrom} 〜 ${invoice.periodTo}`}
      </p>

      {result?.failure === "INVALID" ? (
        <p className="pk-notice pk-notice--warn">{t("billing.pay.invalidDate")}</p>
      ) : null}
      {result?.failure === "ALREADY_PAID" ? (
        <p className="pk-notice pk-notice--warn">{t("billing.pay.alreadyPaid")}</p>
      ) : null}
      {result?.failure === "NOT_PAYABLE" ? (
        <p className="pk-notice pk-notice--warn">{t("billing.pay.notPayable")}</p>
      ) : null}
      {result?.paid === true ? (
        <p className="pk-notice">
          {`${t("billing.pay.done")}${result.documentNo === undefined ? "" : ` (${result.documentNo})`}`}
        </p>
      ) : null}

      {/* KPI。**金額より件数が先**（プロトタイプの確定事項）。 */}
      <dl className="pk-stats">
        <div className="pk-stats__item">
          <dt>{t("billing.kpi.cleaningCount")}</dt>
          <dd>
            {String(data.cleaningCount)}
            <span className="pk-stats__unit">{t("billing.unit.rooms")}</span>
          </dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("billing.kpi.totalAmount")}</dt>
          <dd>
            {formatYenAmount(invoice.totalAmount)}
            <span className="pk-stats__unit">{t("billing.unit.yen")}</span>
          </dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("billing.kpi.dueDate")}</dt>
          <dd className="pk-stats__small">{invoice.dueDate}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("billing.kpi.status")}</dt>
          <dd className="pk-stats__small">{t(INVOICE_STATUS_LABEL[invoice.status])}</dd>
        </div>
      </dl>
      <p className="pk-muted">{t("billing.kpi.note")}</p>

      {/* ── 内訳 ──────────────────────────────────────── */}
      <h2 className="pk-section__title">{t("billing.lines.title")}</h2>
      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("billing.lines.description")}</th>
            <th>{t("billing.lines.unitPrice")}</th>
            <th>{t("billing.lines.quantity")}</th>
            <th>{t("billing.lines.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((line) => (
            <tr key={line.lineNo}>
              <th scope="row">{line.description}</th>
              <td>{`${formatYenAmount(line.unitPrice)} ${t("billing.unit.yen")}`}</td>
              <td>{`${String(line.quantity)} ${line.unit}`}</td>
              <td>{`${formatYenAmount(line.amount)} ${t("billing.unit.yen")}`}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              {t("billing.lines.subtotal")}
            </th>
            <td>{`${formatYenAmount(invoice.subtotalAmount)} ${t("billing.unit.yen")}`}</td>
          </tr>
          {data.taxes.map((tax) => (
            <tr key={tax.taxRate}>
              <th scope="row" colSpan={3}>
                {`${t("billing.lines.tax")}（${String(tax.taxRate)}${t("billing.unit.percent")}）`}
              </th>
              <td>{`${formatYenAmount(tax.taxAmount)} ${t("billing.unit.yen")}`}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" colSpan={3}>
              {t("billing.lines.total")}
            </th>
            <td>{`${formatYenAmount(invoice.totalAmount)} ${t("billing.unit.yen")}`}</td>
          </tr>
        </tfoot>
      </table>
      {invoice.isQualifiedInvoice ? null : (
        <p className="pk-muted">{t("billing.notQualified")}</p>
      )}

      {/* ── 契約の内容 ────────────────────────────────── */}
      <h2 className="pk-section__title">{t("billing.contract.title")}</h2>
      {data.counterparty === null ? (
        <p className="pk-muted">{t("billing.contract.missing")}</p>
      ) : (
        <table className="pk-grid">
          <tbody>
            <tr>
              <th scope="row">{t("billing.contract.counterparty")}</th>
              <td>{data.counterparty.name}</td>
            </tr>
            <tr>
              <th scope="row">{t("billing.contract.closingDay")}</th>
              <td>{String(data.counterparty.closingDay)}</td>
            </tr>
            <tr>
              <th scope="row">{t("billing.contract.paymentTermDays")}</th>
              <td>{String(data.counterparty.paymentTermDays)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {data.prices.length === 0 ? null : (
        <>
          {/* 単価は表示専用（プロトタイプの確定事項）。変更は取引先と料金の画面で。 */}
          <p className="pk-muted">{t("billing.contract.priceNote")}</p>
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("billing.contract.item")}</th>
                <th>{t("billing.contract.unitPrice")}</th>
                <th>{t("billing.contract.validity")}</th>
              </tr>
            </thead>
            <tbody>
              {data.prices.map((price, index) => (
                <tr key={`${price.itemCode}-${String(index)}`}>
                  <th scope="row">{labelOfItemCode(price.itemCode)}</th>
                  <td>{`${formatYenAmount(price.unitPrice)} ${t("billing.unit.yen")}`}</td>
                  <td>{`${price.validFrom} 〜 ${price.validTo ?? ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* ── 帳票 ──────────────────────────────────────── */}
      <h2 className="pk-section__title">{t("billing.pdf.title")}</h2>
      <p>
        <a className="pk-button" href={`/api/v1/invoices/${invoice.id}/download`}>
          {t("billing.pdf.download")}
        </a>
      </p>

      {/* ── 入金の記録（銀行振込）──────────────────────── */}
      {invoice.paidDate !== null ? (
        <p className="pk-notice">{`${t("billing.pay.paidOn")} ${invoice.paidDate}`}</p>
      ) : null}
      {data.canRecordPayment ? (
        <>
          <h2 className="pk-section__title">{t("billing.pay.title")}</h2>
          <p className="pk-muted">{t("billing.pay.lede")}</p>
          <Form method="post" className="pk-filter">
            <label className="pk-field">
              <span className="pk-field__label">{t("billing.pay.receivedDate")}</span>
              <input className="pk-input" type="date" name="receivedDate" required />
            </label>
            <button className="pk-button" type="submit">
              {t("billing.pay.submit")}
            </button>
          </Form>
        </>
      ) : null}
    </section>
  );
}

/** 料金の品目。取引先と料金の画面（W-18）と同じキー（`cp.item.*`）を引く。 */
function labelOfItemCode(itemCode: string): string {
  const key = `cp.item.${itemCode}`;
  return t(key as MessageKey);
}
