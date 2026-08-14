import { ALL_PROPERTIES, monthSchema, type VendorPlanResponse } from "@pk/contracts";
import { Form, redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { ORGANIZATION_TARGET, can } from "../../lib/auth/permission.js";
import { currentMonthOf } from "../../lib/dashboard/org.js";
import {
  formatHours,
  formatYen,
  hourlyRate,
  isLowHourlyRate,
  orDash,
} from "../../lib/dashboard/format.js";
import { averageRateBasis, buildVendorPlan } from "../../lib/dashboard/vendor.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { ScopeForbiddenError, switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { HOME_PATH, requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * 清掃会社プラン（PK-SPEC-P5 §7.2）。
 *
 *   /app/org/vendor-plan?month=2026-09
 *
 * task:  docs/tasks/P5-15.md
 * ルール: .claude/rules/billing.md §4 / .claude/rules/security.md §5 /
 *        .claude/rules/ui-writing.md §2
 *
 * ── W-02 と別の画面にした ───────────────────────────────
 * §7.1 は**ホテル側**の見え方（1 室あたり原価がいくらか）、§7.2 は
 * **清掃会社側**の見え方（その施設で採算が取れているか）。同じ月の同じ
 * rollup を読むが、見る人の立場が逆で、並ぶ列も税区分も違う。
 * 1 画面にまとめると、どちらの立場で読む数字なのかが混ざる。
 *
 * ── 到達できないロールは既定の画面へ戻す ────────────────
 * 請求情報を見られないロール（`INSPECTOR` / `CLEANER` / `VENDOR_ADMIN`）と、
 * 全社ビューを持たないロールは URL を直に打っても入れない。**画面では
 * 403 を見せずに戻す**（W-02 と同じ / 業務を止めない）。API は 404 / 403。
 *
 * ── 評価に使う画面ではない ──────────────────────────────
 * 「稼働スタッフ」は人数だけで、個人の一覧も個人別の実績も出さない
 * （security.md §5）。時間単価は**施設**の採算であって、そこで働く人の
 * 速さではない。
 *
 * ── 税込と税抜が並ぶ ────────────────────────────────────
 * 請求状況は税込（帳票そのもの）、施設別収支は税抜（明細の合計）。
 * **どちらの表にも単位を書く**（`contracts/vendorPlan.ts` の注記）。
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  // 請求を見られないロールは、そもそもこの画面の数字に触れない。
  if (!can(tenant, "billing.read", ORGANIZATION_TARGET)) throw redirect(HOME_PATH);

  try {
    await switchProperty(env, tenant, cookieValue, ALL_PROPERTIES, now, session.membershipId);
  } catch (error) {
    if (error instanceof ScopeForbiddenError) throw redirect(HOME_PATH);
    throw error;
  }

  // 形が違う `month` は今月に落とす（画面なので 400 を見せない / W-02 と同じ）。
  const requested = new URL(request.url).searchParams.get("month");
  const parsed = requested === null ? null : monthSchema.safeParse(requested);
  const month = parsed?.success === true ? parsed.data : currentMonthOf(now);

  return await buildVendorPlan(env, tenant, month);
}

/** 表示の状態 → 文言キー（§7.2 の「状態」欄）。 */
const STATE_LABEL = {
  AGGREGATING: "vendorPlan.state.aggregating",
  REVIEWING: "vendorPlan.state.reviewing",
  AGREED: "vendorPlan.state.agreed",
  ISSUED: "vendorPlan.state.issued",
  SENT: "vendorPlan.state.sent",
  PAID: "vendorPlan.state.paid",
  OVERDUE: "vendorPlan.state.overdue",
  VOIDED: "vendorPlan.state.voided",
} as const satisfies Record<string, MessageKey>;

export default function VendorPlan() {
  const data = useLoaderData<VendorPlanResponse>();
  const { summary } = data;

  // 組織平均の時間単価。**施設の単価を平均しない**（`vendor.ts` の注記）。
  const basis = averageRateBasis(data.properties);
  const averageRate = hourlyRate(basis.billedAmount, basis.totalMinutes);

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("vendorPlan.title")}</h1>
      </div>

      <Form method="get" className="pk-filter">
        <label className="pk-field">
          <span className="pk-field__label">{t("vendorPlan.month")}</span>
          <input className="pk-input" type="month" name="month" defaultValue={data.month} />
        </label>
        <button className="pk-button" type="submit">
          {t("vendorPlan.apply")}
        </button>
      </Form>

      {/* 集計がまだ無い月に 0 を並べない（W-02 と同じ判断）。 */}
      {!data.hasRollup ? <p className="pk-muted">{t("vendorPlan.noRollup")}</p> : null}

      <dl className="pk-stats">
        <div className="pk-stats__item">
          <dt>{t("vendorPlan.propertyCount")}</dt>
          <dd>{summary.propertyCount}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("vendorPlan.staffCount")}</dt>
          <dd>
            {summary.staffCount}
            <span className="pk-stats__unit">{t("vendorPlan.unit.people")}</span>
          </dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("vendorPlan.totalTasks")}</dt>
          <dd>{summary.totalTasks}</dd>
        </div>
      </dl>
      {/* 在籍者数であって「その月に働いた人数」ではない（DECISIONS #135）。 */}
      <p className="pk-muted">{t("vendorPlan.staffCountNote")}</p>

      <h2 className="pk-section__title">{t("vendorPlan.billing")}</h2>
      {data.billing.length === 0 ? (
        <p className="pk-muted">{t("vendorPlan.noBilling")}</p>
      ) : (
        <>
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("vendorPlan.column.counterparty")}</th>
                <th>{t("vendorPlan.column.period")}</th>
                <th>{t("vendorPlan.column.amount")}</th>
                <th>{t("vendorPlan.column.state")}</th>
              </tr>
            </thead>
            <tbody>
              {data.billing.map((row) => (
                <tr key={`${row.counterpartyId}:${row.periodFrom}:${row.periodTo}`}>
                  <th scope="row">{row.counterpartyName}</th>
                  <td>
                    {row.periodFrom}
                    <span className="pk-stats__unit">{t("vendorPlan.periodSeparator")}</span>
                    {row.periodTo}
                  </td>
                  <td>
                    {orDash(formatYen(row.amount))}
                    {/* 確定していない金額に印を付ける。合意の途中で見せた
                        写しを、請求済みの額と同じ顔で並べない。 */}
                    {row.amount !== null && !row.isConfirmedAmount ? (
                      <span className="pk-badge pk-badge--hidden">{t("vendorPlan.provisionalAmount")}</span>
                    ) : null}
                  </td>
                  <td>
                    {t(STATE_LABEL[row.state])}
                    {row.needsAction ? (
                      <span className="pk-badge pk-badge--warn">{t("vendorPlan.needsAction")}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="pk-stats">
            <div className="pk-stats__item">
              <dt>{t("vendorPlan.salesTotal")}</dt>
              <dd>{orDash(formatYen(summary.salesTotal))}</dd>
            </div>
            <div className="pk-stats__item">
              <dt>{t("vendorPlan.unpaidTotal")}</dt>
              <dd>{orDash(formatYen(summary.unpaidTotal))}</dd>
            </div>
          </dl>
          <p className="pk-muted">{t("vendorPlan.salesNote")}</p>
        </>
      )}

      <h2 className="pk-section__title">{t("vendorPlan.byProperty")}</h2>
      {data.properties.length === 0 ? (
        <p className="pk-muted">{t("vendorPlan.noProperties")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("vendorPlan.column.property")}</th>
              <th>{t("vendorPlan.column.totalTasks")}</th>
              <th>{t("vendorPlan.column.billedAmount")}</th>
              <th>{t("vendorPlan.column.hours")}</th>
              <th>{t("vendorPlan.column.hourlyRate")}</th>
            </tr>
          </thead>
          <tbody>
            {data.properties.map((row) => {
              const rate = hourlyRate(row.billedAmount, row.totalMinutes);
              return (
                <tr key={row.propertyId}>
                  <th scope="row">{row.name}</th>
                  <td>{row.totalTasks}</td>
                  <td>{orDash(formatYen(row.billedAmount))}</td>
                  <td>
                    {formatHours(row.totalMinutes)}
                    <span className="pk-stats__unit">{t("vendorPlan.unit.hours")}</span>
                  </td>
                  <td>
                    {orDash(formatYen(rate))}
                    {/* §7.2 MUST: 組織平均の 85% を下回る施設に警告。
                        **急かす色にしない**（ui-writing.md §3）。 */}
                    {isLowHourlyRate(rate, averageRate) ? (
                      <span className="pk-badge pk-badge--warn">{t("vendorPlan.lowRate")}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="pk-muted">{t("vendorPlan.rateNote")}</p>
    </section>
  );
}
