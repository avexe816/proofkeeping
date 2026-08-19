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

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("billing.title")}</h1>
      </div>
      <p className="pk-muted">{t("billing.lede")}</p>

      {data.rows.length === 0 ? (
        <p className="pk-muted">{t("billing.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("billing.column.documentNo")}</th>
              <th>{t("billing.column.period")}</th>
              <th>{t("billing.column.counterparty")}</th>
              <th>{t("billing.column.amount")}</th>
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
                <td>{`${formatYenAmount(row.totalAmount)} ${t("billing.unit.yen")}`}</td>
                <td>{t(INVOICE_STATUS_LABEL[row.status])}</td>
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
      )}
    </section>
  );
}
