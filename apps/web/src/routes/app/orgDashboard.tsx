import { ALL_PROPERTIES, monthSchema, type OrgDashboardResponse } from "@pk/contracts";
import { Form, redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { buildOrgDashboard, currentMonthOf } from "../../lib/dashboard/org.js";
import {
  costPerTask,
  formatAverageMinutes,
  formatPercent,
  formatYen,
  orDash,
} from "../../lib/dashboard/format.js";
import { t } from "../../lib/i18n.js";
import { ScopeForbiddenError, switchProperty } from "../../lib/property/selection.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { HOME_PATH, requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * W-02 組織ダッシュボード（PK-SPEC-P5 §7.1）。
 *
 *   /app/org/dashboard?month=2026-09
 *
 * task:  docs/tasks/P5-14.md
 * ルール: .claude/rules/architecture.md §3 / .claude/rules/ui-writing.md §2
 *
 * ── P0-21 の画面を育てたもの ────────────────────────────
 * この経路には P0-21 が**単日の施設別サマリー**を置いていた
 * （PK-SPEC-P0 §23.5）。§7.1 は同じ画面の月次版で、全社サマリーと
 * 施設別比較と要対応が付く。**別経路を作らず、こちらを伸ばした。**
 * 同じ「全社の様子」を 2 つの URL で見せる形にしない。
 *
 * ── 全社ビューを持たないロールはここへ来られない ────────
 * URL 直打ちは `ScopeForbiddenError` になるので、既定の画面へ戻す
 * （画面では 403 を見せずに戻す — 業務を止めない）。API は 403 を返す。
 *
 * ── 稼働の数字は rollup だけ（§7.1 MUST）────────────────
 * 集計は `lib/dashboard/org.ts`。金額と要対応の出どころもそちらの注記。
 *
 * ── 評価に使う画面ではない ──────────────────────────────
 * 施設別比較は施設の比較であって、**人の比較ではない**
 * （security.md §5 / ui-writing.md §3）。個人単位の数字を足さないこと。
 * 「差異」の列は重大な差異の件数で、`CLEANER` / `INSPECTOR` は
 * そもそもこの画面へ到達できない（security.md §1）。
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  // URL を正としてセッションを `"ALL"` へ寄せる（§23.5）。
  try {
    await switchProperty(env, tenant, cookieValue, ALL_PROPERTIES, now, session.membershipId);
  } catch (error) {
    if (error instanceof ScopeForbiddenError) throw redirect(HOME_PATH);
    throw error;
  }

  // 形が違う `month` は**今月に落とす。** 画面なので 400 を見せない。
  const requested = new URL(request.url).searchParams.get("month");
  const parsed = requested === null ? null : monthSchema.safeParse(requested);
  const month = parsed?.success === true ? parsed.data : currentMonthOf(now);

  return await buildOrgDashboard(env, tenant, month);
}

export default function OrgDashboard() {
  const data = useLoaderData<OrgDashboardResponse>();
  const { summary } = data;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("dashboard.org.title")}</h1>
      </div>

      <Form method="get" className="pk-filter">
        <label className="pk-field">
          <span className="pk-field__label">{t("dashboard.org.month")}</span>
          <input className="pk-input" type="month" name="month" defaultValue={data.month} />
        </label>
        <button className="pk-button" type="submit">
          {t("dashboard.org.apply")}
        </button>
      </Form>

      {/* 集計がまだ無い月に 0 を並べない（`hasRollup` / P0-21 と同じ判断）。 */}
      {!data.hasRollup ? <p className="pk-muted">{t("dashboard.org.noRollup")}</p> : null}

      <h2 className="pk-section__title">{t("dashboard.org.summary")}</h2>
      <dl className="pk-stats">
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.propertyCount")}</dt>
          <dd>{summary.propertyCount}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.roomCount")}</dt>
          <dd>{summary.roomCount}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.totalTasks")}</dt>
          <dd>{summary.totalTasks}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.completionRate")}</dt>
          <dd>{orDash(formatPercent(summary.completedTasks, summary.totalTasks))}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.firstPassRate")}</dt>
          <dd>{orDash(formatPercent(summary.firstPassTasks, summary.inspectedTasks))}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.reworkRate")}</dt>
          <dd>{orDash(formatPercent(summary.reworkTasks, summary.totalTasks))}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.averageMinutes")}</dt>
          <dd>
            {orDash(formatAverageMinutes(summary.totalMinutes, summary.completedTasks))}
            <span className="pk-stats__unit">{t("dashboard.org.unit.minutes")}</span>
          </dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.cleaningCost")}</dt>
          <dd>{orDash(formatYen(summary.cleaningCost))}</dd>
        </div>
        <div className="pk-stats__item">
          <dt>{t("dashboard.org.costPerTask")}</dt>
          <dd>{orDash(formatYen(costPerTask(summary.cleaningCost, summary.totalTasks)))}</dd>
        </div>
      </dl>
      {/* 費用が確定していない月に 0 円と書かない（DECISIONS #132）。 */}
      {summary.cleaningCost === null ? (
        <p className="pk-muted">{t("dashboard.org.costUnavailable")}</p>
      ) : null}

      <h2 className="pk-section__title">{t("dashboard.org.byProperty")}</h2>
      {data.properties.length === 0 ? (
        <p className="pk-muted">{t("dashboard.org.noProperties")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("dashboard.org.column.property")}</th>
              <th>{t("dashboard.org.column.totalTasks")}</th>
              <th>{t("dashboard.org.column.completionRate")}</th>
              <th>{t("dashboard.org.column.firstPassRate")}</th>
              <th>{t("dashboard.org.column.averageMinutes")}</th>
              <th>{t("dashboard.org.column.costPerTask")}</th>
              <th>{t("dashboard.org.column.findings")}</th>
            </tr>
          </thead>
          <tbody>
            {data.properties.map((row) => (
              <tr key={row.propertyId}>
                <th scope="row">{row.name}</th>
                <td>{row.totalTasks}</td>
                <td>{orDash(formatPercent(row.completedTasks, row.totalTasks))}</td>
                <td>{orDash(formatPercent(row.firstPassTasks, row.inspectedTasks))}</td>
                <td>{orDash(formatAverageMinutes(row.totalMinutes, row.completedTasks))}</td>
                <td>{orDash(formatYen(costPerTask(row.cleaningCost, row.totalTasks)))}</td>
                <td>{row.findingsHigh}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="pk-section__title">{t("dashboard.org.actions")}</h2>
      <ul className="pk-actions">
        {actionRows(data).map((row) => (
          <li className="pk-actions__item" key={row.label}>
            <span className="pk-actions__label">{t(row.label)}</span>
            <span className="pk-actions__count">{row.count}</span>
            {/* **画面が無いものにリンクを出さない。** 押して 404 になる
                導線を置くくらいなら、件数だけを出して気づかせる。 */}
            {row.href === null ? null : (
              <a className="pk-button" href={row.href}>
                {t("dashboard.org.action.open")}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 要対応の 4 行（§7.1 の下段）。
 *
 * ── リンク先がある行と無い行がある ──────────────────────
 * 差異レポートには一覧画面（W-06 / P4-06）がある。**忘れ物・設備不具合・
 * 請求期間の PC 画面はまだ無い**（API だけがある）。作られたらここへ
 * `href` を足す。件数は今のうちから出しておく — 見えないと、
 * 保管期限も締めも「誰も見ていない」まま過ぎる。
 */
function actionRows(data: OrgDashboardResponse) {
  return [
    {
      label: "dashboard.org.action.findings",
      count: data.actions.openFindings,
      href: "/app/audit/findings",
    },
    { label: "dashboard.org.action.issues", count: data.actions.openIssues, href: null },
    {
      label: "dashboard.org.action.lostItems",
      count: data.actions.expiringLostItems,
      href: null,
    },
    {
      label: "dashboard.org.action.billingPeriods",
      count: data.actions.unclosedBillingPeriods,
      href: null,
    },
  ] as const;
}
