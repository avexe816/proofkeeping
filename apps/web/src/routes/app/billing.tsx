/**
 * W-12 契約と請求（PK-SPEC-P5 §6 / プロトタイプ 10）。
 *
 *   /app/billing?invoiceId=...
 *
 * 経緯:  人間の指示 2026-08-17「Stripe は契約しない。日本企業は銀行振込が
 *        主なので、契約と請求は銀行振込前提で実現する」。
 *        人間の指示 2026-08-20「プロトタイプの 3 枚の画像どおりに」。
 * 参照:  ui-prototypes/owner/pkown-v3-D-billing-settings-perm.html（10）
 * ルール: .claude/rules/billing.md / security.md §1（INSPECTOR は請求を見ない）
 *
 * ── プロトタイプ 10 は 1 枚の画面 ───────────────────────
 * 対象月のセレクタ＋請求書 PDF（pagehead）→ KPI 4 枚 → ご請求の内訳と
 * 契約の内容の並置 → 請求の履歴、までが**同じ画面**に載る（DECISIONS #214）。
 * 一覧と明細を別ルートに割ると、履歴の行を押すまで内訳が見えない。
 *
 * ── 選んだ 1 件が画面の上半分 ───────────────────────────
 * `?invoiceId=` が選択。未指定なら**最新の 1 件**（`listInvoices()` は
 * 発行日の新しい順）。プロトタイプの「2026年7月分」に当たる。
 *
 * ── 入金の記録は明細画面 ────────────────────────────────
 * 銀行振込は着金が非同期で、人が明細を確かめてから記録する。ここには
 * 入金のボタンを置かない（履歴の行から `/app/billing/{id}` へ）。
 *
 * ── 金額は整数（円）・税込表示 ──────────────────────────
 * billing.md §4。浮動小数点を使わない。
 */

import {
  findCounterpartyById,
  findInvoiceById,
  findInvoiceRoomQuantities,
  listInvoiceLines,
  listInvoiceTaxSummaries,
  listInvoices,
  listPricingRules,
  type InvoiceStatus,
} from "@pk/db";
import { Form, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { INVOICE_STATUS_LABEL, formatYenAmount } from "../../lib/billing/labels.js";
import { t, type MessageKey } from "../../lib/i18n.js";
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
  /** 単位が「室」の明細の数量合計。**明細画面の KPI と同じ定義。** */
  cleaningCount: number;
  /** セレクタと履歴に出す「2026年7月分」。 */
  monthLabel: string;
}

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
  taxAmount: number;
}

interface PriceRow {
  itemCode: string;
  unitPrice: number;
}

/** 選んだ 1 件（画面の上半分）。請求書が 1 件も無ければ `null`。 */
interface SelectedInvoice {
  row: InvoiceRow;
  lines: LineRow[];
  taxes: TaxRow[];
  subtotalAmount: number;
  isQualifiedInvoice: boolean;
  counterparty: {
    name: string;
    closingDay: number;
    paymentTermDays: number;
  } | null;
  prices: PriceRow[];
  /** 0 円で計上した明細があるか（プロトタイプの「再清掃は無償です」）。 */
  hasFreeLine: boolean;
}

interface BillingData {
  rows: InvoiceRow[];
  selected: SelectedInvoice | null;
}

/** `YYYY-MM-DD` → 「2026年7月分」。**対象期間の末日で数える。** */
function monthLabelOf(periodTo: string): string {
  const [year, month] = periodTo.split("-");
  // 先頭の 0 を落とす（「07月分」ではなく「7月分」）。
  return `${year ?? ""}年${String(Number(month ?? "0"))}月分`;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<BillingData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);

  // API（/api/v1/invoices）と同じ門。`INSPECTOR` / `CLEANER` は 404。
  assertPermission(tenant, "billing.readInternal", ORGANIZATION_TARGET);

  const invoices = await listInvoices(env, tenant, { limit: 100 });

  // 清掃件数は**1 文でまとめて引く**（行ごとに明細を読むと N+1）。
  const roomCounts = await findInvoiceRoomQuantities(
    env,
    tenant,
    invoices.map((invoice) => invoice.id),
  );

  const rows: InvoiceRow[] = invoices.map((invoice) => ({
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
    cleaningCount: roomCounts.get(invoice.id) ?? 0,
    monthLabel: monthLabelOf(invoice.periodTo),
  }));

  // **`?invoiceId=` は候補の中にあるものだけを採る。** 見つからなければ
  // 最新へ落とす（別組織の ID は `findInvoiceById()` が 404 にするが、
  // ここで候補に絞っておけば DB へ行かずに済む）。
  const requestedId = new URL(request.url).searchParams.get("invoiceId");
  const selectedRow =
    rows.find((row) => row.id === requestedId) ?? rows[0] ?? null;

  if (selectedRow === null) return { rows, selected: null };

  const invoice = await findInvoiceById(env, tenant, selectedRow.id);
  if (invoice === undefined) return { rows, selected: null };

  const [lines, taxes, counterparty, prices] = await Promise.all([
    listInvoiceLines(env, tenant, invoice.id),
    listInvoiceTaxSummaries(env, tenant, invoice.id),
    findCounterpartyById(env, tenant, invoice.counterpartyId),
    listPricingRules(env, tenant, { counterpartyId: invoice.counterpartyId }),
  ]);

  return {
    rows,
    selected: {
      row: selectedRow,
      lines: lines.map((line) => ({
        lineNo: line.lineNo,
        description: line.description,
        unitPrice: line.unitPrice,
        quantity: line.quantity,
        unit: line.unit,
        amount: line.amount,
      })),
      taxes: taxes.map((tax) => ({ taxRate: tax.taxRate, taxAmount: tax.taxAmount })),
      subtotalAmount: invoice.subtotalAmount,
      isQualifiedInvoice: invoice.isQualifiedInvoice,
      counterparty:
        counterparty === undefined
          ? null
          : {
              name: counterparty.displayName ?? counterparty.legalName,
              closingDay: counterparty.closingDay,
              paymentTermDays: counterparty.paymentTermDays,
            },
      // **現に発行済みの単価だけを出す。** 期間の切れた行は契約の現況ではない。
      prices: prices
        .filter((rule) => rule.validTo === null)
        .map((rule) => ({ itemCode: rule.itemCode, unitPrice: rule.unitPrice })),
      // プロトタイプの「再清掃は無償です」。**固定文にしない** — 0 円の行が
      // 実際にあるときだけ出す（単価は組織の料金設定で決まる）。
      hasFreeLine: lines.some((line) => line.amount === 0),
    },
  };
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

/** 料金の品目。取引先と料金の画面（W-18）と同じキー（`cp.item.*`）を引く。 */
function labelOfItemCode(itemCode: string): string {
  return t(`cp.item.${itemCode}` as MessageKey);
}

export default function Billing() {
  const data = useLoaderData<BillingData>();
  const selected = data.selected;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("billing.title")}</h1>
          <p className="pk-pagehead__sub">
            {selected === null
              ? t("billing.lede")
              : `${selected.row.counterpartyName} · ${selected.row.monthLabel}`}
          </p>
        </div>

        {selected === null ? null : (
          <div className="pk-pagehead__actions">
            {/* 対象月の切替。**JS 無しでも切り替わる**よう submit で送る
                （施設セレクタと同じ判断 / `ui/PropertySwitcher.tsx`）。 */}
            <Form method="get" className="pk-inlineform">
              <label className="pk-visually-hidden" htmlFor="invoiceId">
                {t("billing.selector.label")}
              </label>
              <select
                className="pk-select"
                id="invoiceId"
                name="invoiceId"
                defaultValue={selected.row.id}
              >
                {data.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {`${row.monthLabel} · ${row.counterpartyName}`}
                  </option>
                ))}
              </select>
              <button className="pk-button" type="submit">
                {t("billing.selector.show")}
              </button>
            </Form>
            <a
              className="pk-button pk-button--primary"
              href={`/api/v1/invoices/${selected.row.id}/download`}
            >
              {t("billing.pdf.download")}
            </a>
          </div>
        )}
      </div>

      {selected === null ? (
        <p className="pk-muted">{t("billing.empty")}</p>
      ) : (
        <>
          {/* KPI。**金額より件数が先**（プロトタイプの確定事項: 根拠を先に見せる）。 */}
          <dl className="pk-stats">
            <div className="pk-stats__item">
              <dt>{t("billing.kpi.cleaningCount")}</dt>
              <dd>
                {String(selected.row.cleaningCount)}
                <span className="pk-stats__unit">{t("billing.unit.rooms")}</span>
              </dd>
            </div>
            <div className="pk-stats__item">
              <dt>{t("billing.kpi.totalAmount")}</dt>
              <dd>
                {formatYenAmount(selected.row.totalAmount)}
                <span className="pk-stats__unit">{t("billing.unit.yen")}</span>
              </dd>
            </div>
            <div className="pk-stats__item pk-stats__item--accent-info">
              <dt>{t("billing.kpi.dueDate")}</dt>
              <dd className="pk-stats__small">{selected.row.dueDate}</dd>
            </div>
            <div
              className={`pk-stats__item${
                selected.row.status === "PAID" ? " pk-stats__item--accent-ok" : ""
              }`}
            >
              <dt>{t("billing.kpi.status")}</dt>
              <dd className="pk-stats__small">{t(INVOICE_STATUS_LABEL[selected.row.status])}</dd>
            </div>
          </dl>
          <p className="pk-muted">{t("billing.kpi.note")}</p>

          {/* 内訳と契約の内容を並置（プロトタイプ 10 の g21）。 */}
          <div className="pk-cols pk-cols--21">
            <section className="pk-panel">
              <div className="pk-panel__head">
                {t("billing.lines.title")}
                <span className="pk-panel__note">
                  {`${selected.row.periodFrom} 〜 ${selected.row.periodTo}`}
                </span>
              </div>
              <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
                <table className="pk-tbl">
                  <thead>
                    <tr>
                      <th>{t("billing.lines.description")}</th>
                      <th className="pk-num">{t("billing.lines.unitPrice")}</th>
                      <th className="pk-num">{t("billing.lines.quantity")}</th>
                      <th className="pk-num">{t("billing.lines.amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.lines.map((line) => (
                      <tr key={line.lineNo}>
                        <th scope="row">{line.description}</th>
                        <td className="pk-num">{`${formatYenAmount(line.unitPrice)} ${t("billing.unit.yen")}`}</td>
                        <td className="pk-num">{`${String(line.quantity)} ${line.unit}`}</td>
                        {/* 0 円の行は緑。**消さずに残す**（発生した事実を隠さない）。 */}
                        <td className={`pk-num${line.amount === 0 ? " pk-allow" : ""}`}>
                          {`${formatYenAmount(line.amount)} ${t("billing.unit.yen")}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3}>{t("billing.lines.subtotal")}</td>
                      <td className="pk-num">{`${formatYenAmount(selected.subtotalAmount)} ${t("billing.unit.yen")}`}</td>
                    </tr>
                    {selected.taxes.map((tax) => (
                      <tr key={tax.taxRate}>
                        <td colSpan={3}>
                          {`${t("billing.lines.tax")}（${String(tax.taxRate)}${t("billing.unit.percent")}）`}
                        </td>
                        <td className="pk-num">{`${formatYenAmount(tax.taxAmount)} ${t("billing.unit.yen")}`}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={3}>{t("billing.lines.total")}</td>
                      <td className="pk-num">{`${formatYenAmount(selected.row.totalAmount)} ${t("billing.unit.yen")}`}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {selected.hasFreeLine ? (
                <div className="pk-panel__body">
                  <p className="pk-notice pk-notice--info">{t("billing.lines.freeNote")}</p>
                </div>
              ) : null}
              {selected.isQualifiedInvoice ? null : (
                <div className="pk-panel__foot">{t("billing.notQualified")}</div>
              )}
            </section>

            <section className="pk-panel">
              <div className="pk-panel__head">
                {t("billing.contract.title")}
                <span className="pk-lock">{t("billing.contract.lock")}</span>
              </div>
              {selected.counterparty === null ? (
                <div className="pk-panel__body">
                  <p className="pk-muted">{t("billing.contract.missing")}</p>
                </div>
              ) : (
                <div className="pk-panel__body pk-panel__body--flush">
                  <table className="pk-tbl">
                    <tbody>
                      <tr>
                        <td className="pk-muted">{t("billing.contract.counterparty")}</td>
                        <td>{selected.counterparty.name}</td>
                      </tr>
                      <tr>
                        <td className="pk-muted">{t("billing.contract.period")}</td>
                        <td>{`${selected.row.periodFrom} 〜 ${selected.row.periodTo}`}</td>
                      </tr>
                      <tr>
                        <td className="pk-muted">{t("billing.contract.closingDay")}</td>
                        <td>{String(selected.counterparty.closingDay)}</td>
                      </tr>
                      <tr>
                        <td className="pk-muted">{t("billing.contract.paymentTermDays")}</td>
                        <td>{String(selected.counterparty.paymentTermDays)}</td>
                      </tr>
                      <tr>
                        <td className="pk-muted">{t("billing.contract.dueDate")}</td>
                        <td>{selected.row.dueDate}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              {selected.prices.length === 0 ? null : (
                <div className="pk-panel__body pk-panel__body--flush">
                  <table className="pk-tbl">
                    <thead>
                      <tr>
                        <th>{t("billing.contract.priceTable")}</th>
                        <th className="pk-num">{t("billing.contract.unitPrice")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.prices.map((price, index) => (
                        <tr key={`${price.itemCode}-${String(index)}`}>
                          <th scope="row">{labelOfItemCode(price.itemCode)}</th>
                          <td className={`pk-num${price.unitPrice === 0 ? " pk-allow" : ""}`}>
                            {`${formatYenAmount(price.unitPrice)} ${t("billing.unit.yen")}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {/* 単価は表示専用（プロトタイプの確定事項）。変更は取引先と料金の画面で。 */}
              <div className="pk-panel__foot">{t("billing.contract.priceNote")}</div>
            </section>
          </div>
        </>
      )}

      {data.rows.length === 0 ? null : (
        <section className="pk-panel">
          <div className="pk-panel__head">
            {t("billing.history.title")}
            <span className="pk-panel__note">{t("billing.history.note")}</span>
          </div>
          <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
            <table className="pk-tbl">
              <thead>
                <tr>
                  <th>{t("billing.column.month")}</th>
                  <th>{t("billing.column.counterparty")}</th>
                  <th className="pk-num">{t("billing.column.cleaningCount")}</th>
                  <th className="pk-num">{t("billing.column.amount")}</th>
                  <th>{t("billing.column.status")}</th>
                  <th>{t("billing.column.paidDate")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.id === selected?.row.id ? <b>{row.monthLabel}</b> : row.monthLabel}
                      {row.isCreditNote ? (
                        <span className="pk-badge pk-badge--warn">{t("billing.creditNote")}</span>
                      ) : null}
                    </th>
                    <td>{row.counterpartyName}</td>
                    <td className="pk-num">
                      {`${String(row.cleaningCount)} ${t("billing.unit.rooms")}`}
                    </td>
                    <td className="pk-num">{`${formatYenAmount(row.totalAmount)} ${t("billing.unit.yen")}`}</td>
                    <td>
                      <span className={`pk-badge ${STATUS_BADGE[row.status]}`}>
                        {t(INVOICE_STATUS_LABEL[row.status])}
                      </span>
                    </td>
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
