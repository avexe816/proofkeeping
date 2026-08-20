/**
 * W-12 契約と請求 — 請求書の一覧。
 *
 *   /app/billing
 *
 * 経緯:  人間の指示 2026-08-17「Stripe は契約しない。日本企業は銀行振込が
 *        主なので、契約と請求は銀行振込前提で実現する」。
 * 参照:  ui-prototypes/owner/pkown-v3-D-billing-settings-perm.html（10）
 * ルール: .claude/rules/billing.md / security.md §1（INSPECTOR は請求を見ない）
 *
 * ── 発行済みの請求書を並べるだけ ────────────────────────
 * 発行の実体は P5 のまま（API `/api/v1/invoices/issue-and-send` と
 * 月次締めバッチ）。この画面は**読む・入金を記録する**の 2 つに絞る
 * （DECISIONS #200）。金額は常に整数（円）・税込表示（billing.md §4）。
 *
 * ── 入金の消込は明細画面で ──────────────────────────────
 * 銀行振込は着金が非同期なので、人が明細を確かめてから記録する。
 * 一覧に「入金」ボタンを並べない（隣の行と押し間違える）。
 */

import { listInvoices, type InvoiceStatus } from "@pk/db";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { INVOICE_STATUS_LABEL, formatYenAmount } from "../../lib/billing/labels.js";
import { t } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

interface InvoiceRow {
  id: string;
  documentNo: string;
  periodFrom: string;
  periodTo: string;
  counterpartyName: string;
  totalAmount: number;
  status: InvoiceStatus;
  dueDate: string;
  /** 入金日（`YYYY-MM-DD` 表示用）。未入金は `null`。 */
  paidDate: string | null;
  isCreditNote: boolean;
}

interface BillingData {
  rows: InvoiceRow[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<BillingData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  // API（/api/v1/invoices）と同じ門。`INSPECTOR` / `CLEANER` は 404。
  assertPermission(tenant, "billing.readInternal", ORGANIZATION_TARGET);

  const invoices = await listInvoices(env, tenant, { limit: 100 });

  return {
    rows: invoices.map((invoice) => ({
      id: invoice.id,
      documentNo: invoice.documentNo,
      periodFrom: invoice.periodFrom,
      periodTo: invoice.periodTo,
      counterpartyName: invoice.counterpartyName,
      totalAmount: invoice.totalAmount,
      status: invoice.status,
      dueDate: invoice.dueDate,
      paidDate: invoice.paidAt === null ? null : invoice.paidAt.toISOString().slice(0, 10),
      isCreditNote: invoice.isCreditNote,
    })),
  };
}

export default function BillingList() {
  const data = useLoaderData<BillingData>();

  // KPI はこの一覧（直近 100 件）から導出する。**別の集計を持たない** —
  // 表と数字が食い違うと、どちらが正か画面から判別できない。
  const unpaid = data.rows.filter(
    (row) => !row.isCreditNote && row.paidDate === null && row.status !== "VOIDED",
  );
  const unpaidTotal = unpaid.reduce((sum, row) => sum + row.totalAmount, 0);
  const nextDue = unpaid.map((row) => row.dueDate).sort()[0] ?? null;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("billing.title")}</h1>
          <p className="pk-pagehead__sub">{t("billing.lede")}</p>
        </div>
      </div>

      {/* プロトタイプ D-10 の KPI 行。金額より先に件数（根拠）を見せる。 */}
      <dl className="pk-stats">
        <div className="pk-stats__item">
          <dt>{t("billing.kpi.invoiceCount")}</dt>
          <dd>
            {String(data.rows.length)}
            <span className="pk-stats__unit">{t("billing.unit.invoices")}</span>
          </dd>
        </div>
        <div className={`pk-stats__item${unpaid.length > 0 ? " pk-stats__item--accent-warn" : ""}`}>
          <dt>{t("billing.kpi.unpaidCount")}</dt>
          <dd>
            {String(unpaid.length)}
            <span className="pk-stats__unit">{t("billing.unit.invoices")}</span>
          </dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("billing.kpi.unpaidTotal")}</dt>
          <dd>
            {formatYenAmount(unpaidTotal)}
            <span className="pk-stats__unit">{t("billing.unit.yen")}</span>
          </dd>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-info">
          <dt>{t("billing.kpi.nextDue")}</dt>
          <dd className="pk-stats__small">{nextDue ?? t("billing.kpi.nextDue.none")}</dd>
        </div>
      </dl>

      {data.rows.length === 0 ? (
        <p className="pk-muted">{t("billing.empty")}</p>
      ) : (
        <section className="pk-panel">
          <div className="pk-panel__head">
            {t("billing.history.title")}
            <span className="pk-panel__note">{t("billing.history.note")}</span>
          </div>
          <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
            <table className="pk-tbl">
              <thead>
                <tr>
                  <th>{t("billing.column.documentNo")}</th>
                  <th>{t("billing.column.period")}</th>
                  <th>{t("billing.column.counterparty")}</th>
                  <th className="pk-num">{t("billing.column.amount")}</th>
                  <th>{t("billing.column.status")}</th>
                  <th>{t("billing.column.dueDate")}</th>
                  <th>{t("billing.column.paidDate")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.documentNo}
                      {row.isCreditNote ? (
                        <span className="pk-badge pk-badge--warn">{t("billing.creditNote")}</span>
                      ) : null}
                    </th>
                    <td>{`${row.periodFrom} 〜 ${row.periodTo}`}</td>
                    <td>{row.counterpartyName}</td>
                    <td className="pk-num">{`${formatYenAmount(row.totalAmount)} ${t("billing.unit.yen")}`}</td>
                    <td>
                      <span className={`pk-badge ${STATUS_BADGE[row.status]}`}>
                        {t(INVOICE_STATUS_LABEL[row.status])}
                      </span>
                    </td>
                    <td>{row.dueDate}</td>
                    <td>{row.paidDate ?? "—"}</td>
                    <td>
                      <a className="pk-button" href={`/app/billing/${row.id}`}>
                        {t("billing.open")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 入金の消込は明細で行う（冒頭の注記）。**一覧にボタンを並べない。** */}
          <div className="pk-panel__foot">{t("billing.history.paymentNote")}</div>
        </section>
      )}
    </section>
  );
}

/** 状態 → バッジの色。**入金済みだけを緑にする**（完了が一目で分かる）。 */
const STATUS_BADGE: Record<InvoiceStatus, string> = {
  DRAFT: "pk-badge--hidden",
  CONFIRMED: "pk-badge--info",
  SENT: "pk-badge--info",
  VIEWED: "pk-badge--info",
  PAID: "pk-badge--ok",
  PARTIALLY_PAID: "pk-badge--warn",
  OVERDUE: "pk-badge--warn",
  VOIDED: "pk-badge--hidden",
};
