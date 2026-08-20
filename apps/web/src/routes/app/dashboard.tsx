import { listRollupsInRange } from "@pk/db";
import { useEffect } from "react";
import { Form, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";

import { businessDateOf } from "../../lib/businessDate.js";
import {
  buildDailyDashboard,
  recentBusinessDates,
  type DailyDashboardView,
} from "../../lib/dashboard/daily.js";
import { t } from "../../lib/i18n.js";
import { buildInspectionQueue } from "../../lib/inspection/queue.js";
import { resolveListScope } from "../../lib/property/listScope.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { getPropertySummaries } from "../../lib/property/summary.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/**
 * ダッシュボード（本日の運用）。
 *
 *   /app/dashboard?businessDate=YYYY-MM-DD
 *
 * 経緯:  人間の指示 2026-08-20「ダッシュボードは pkops-A-daily-quality.html
 *        と一致していない。HTML に合わせて修正」。
 * 参照:  ui-prototypes/ops/pkops-A-daily-quality.html（01 ダッシュボード）
 * ルール: .claude/rules/architecture.md §3・§7 / ui-writing.md §2・§3
 *
 * ── ここは転送ではなくなった（DECISIONS #216）────────────
 * この route は `/app/org/dashboard`（月次の全社サマリー）へ転送する
 * だけの器だった。**ログイン後の着地がこの URL** なのに、プロトタイプ 01
 * の「今日、手が足りているか」を見せる画面がどこにも無かった。
 * 月次のサマリー（PK-SPEC-P5 §7.1）は別の関心なので残し、**ここに
 * 日次の 1 枚を置く。** 月次へは下の導線から辿れる。
 *
 * ── 集計は rollup だけ ──────────────────────────────────
 * architecture.md §3。`getPropertySummaries()`（60 秒の KV キャッシュ）と
 * `listRollupsInRange()` の 2 つ。**タスク表を直に数えない。**
 *
 * ── 個人の数字を出さない ────────────────────────────────
 * プロトタイプの「出勤」「担当」の列は出勤簿（P8-05）が無いため持たない。
 * 中断理由の内訳も、理由を保存する列が無いので出さない
 * （`cleaningTask.pauseCount` は回数だけ / OPEN_QUESTIONS #107）。
 */

/** 自動更新の間隔（ms）。ui-writing.md §3 の「30 秒ごと」。 */
export const REFRESH_INTERVAL_MS = 30_000;

/** 棒グラフの日数（プロトタイプの「直近7日の完了件数」）。 */
const TREND_DAYS = 7;

interface DashboardData extends DailyDashboardView {
  businessDate: string;
  /** 検査待ちの件数（`inspectionQueue.summary`）。 */
  inspectionWaiting: number;
  /** 期限を過ぎた検査。**急かす色にはしない**（ui-writing.md §3）。 */
  inspectionOverSla: number;
  /** 月次の全社サマリーへ辿れるロールか。 */
  canOpenOrgDashboard: boolean;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<DashboardData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  // 施設はヘッダーの施設セレクタが唯一の入口（DECISIONS #204）。
  // **これが唯一の門**（進捗モニタ・検査キューと同じ形）。
  const selectable = await listSelectableProperties(env, tenant);
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, selectable);
  const scope = resolveListScope(tenant, "property.read", property?.id ?? null);

  const url = new URL(request.url);
  const requested = url.searchParams.get("businessDate");
  // 形が違う値は**今日の業務日に落とす**（画面なので 400 を見せない）。
  const businessDate =
    requested !== null && /^\d{4}-\d{2}-\d{2}$/.test(requested)
      ? requested
      : businessDateOf(now);

  const dates = recentBusinessDates(businessDate, TREND_DAYS);
  const [summaries, rollups, queue] = await Promise.all([
    getPropertySummaries(env, tenant, businessDate),
    // 棒グラフと当日の差異件数を**この 1 回でまとめて読む**（日ごとに
    // 引くと 7 往復になる / `listRollupsInRange()` の注記）。
    listRollupsInRange(env, tenant, { from: dates[0] ?? businessDate, to: businessDate }),
    buildInspectionQueue(env, tenant, {
      scope,
      businessDate,
      viewerMembershipId: session.membershipId,
      now,
    }),
  ]);

  const allowed = scope.propertyIds === null ? null : new Set(scope.propertyIds);
  const inScope = rollups.filter((row) => allowed === null || allowed.has(row.propertyId));

  const completedByDate = new Map<string, number>();
  const findingsHighByProperty = new Map<string, number>();
  for (const row of inScope) {
    completedByDate.set(
      row.businessDate,
      (completedByDate.get(row.businessDate) ?? 0) + row.completedTasks,
    );
    if (row.businessDate === businessDate) {
      findingsHighByProperty.set(
        row.propertyId,
        (findingsHighByProperty.get(row.propertyId) ?? 0) + row.findingsHigh,
      );
    }
  }

  return {
    businessDate,
    ...buildDailyDashboard(summaries, scope.propertyIds, findingsHighByProperty, {
      completedByDate,
      dates,
      currentDate: businessDate,
    }),
    inspectionWaiting: queue.summary.total,
    inspectionOverSla: queue.summary.overSla,
    canOpenOrgDashboard: scope.propertyIds === null,
  };
}

/** 「2026-08-11」→「2026年8月11日（火）」。プロトタイプの見出しの形。 */
function formatBusinessDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-");
  const weekday = new Intl.DateTimeFormat("ja-JP", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${businessDate}T00:00:00Z`));
  return `${year ?? ""}年${String(Number(month ?? "0"))}月${String(Number(day ?? "0"))}日（${weekday}）`;
}

export default function Dashboard() {
  const data = useLoaderData<DashboardData>();
  const revalidator = useRevalidator();

  // 30 秒ごとの自動更新（ui-writing.md §3。手動更新も置く）。
  useEffect(() => {
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [revalidator]);

  const { totals } = data;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("dashboard.title")}</h1>
          <p className="pk-pagehead__sub">
            {`${formatBusinessDate(data.businessDate)} · ${t("dashboard.daily.scope")
              .replace("{properties}", String(totals.propertyCount))
              .replace("{rooms}", String(totals.roomCount))}`}
          </p>
        </div>
        <div className="pk-pagehead__actions">
          {/* 業務日の切替（architecture.md §7。カレンダー日ではない）。 */}
          <Form method="get" className="pk-inlineform">
            <label className="pk-visually-hidden" htmlFor="businessDate">
              {t("dashboard.daily.businessDate")}
            </label>
            <input
              className="pk-input"
              id="businessDate"
              name="businessDate"
              type="date"
              defaultValue={data.businessDate}
            />
            <button className="pk-button" type="submit">
              {t("dashboard.daily.show")}
            </button>
          </Form>
          <button
            className="pk-button pk-button--primary"
            type="button"
            onClick={() => {
              void revalidator.revalidate();
            }}
          >
            {t("dashboard.daily.refresh")}
          </button>
        </div>
      </div>

      {totals.propertyCount === 0 ? (
        <p className="pk-muted">{t("dashboard.noProperty")}</p>
      ) : (
        <>
          {/* 集計がまだ無い施設に 0 を並べない（`hasRollup`）。 */}
          {totals.pendingProperties === 0 ? null : (
            <p className="pk-notice">
              {`${t("dashboard.daily.pending")}: ${String(totals.pendingProperties)}`}
            </p>
          )}

          {/* KPI（プロトタイプ 01 の 5 枚）。**急かす赤を使わない。** */}
          <dl className="pk-stats">
            <div className="pk-stats__item pk-stats__item--accent-info">
              <dt>{t("dashboard.daily.kpi.planned")}</dt>
              <dd>
                {String(totals.totalTasks)}
                <span className="pk-stats__unit">{t("dashboard.daily.unit.rooms")}</span>
              </dd>
            </div>
            <div className="pk-stats__item pk-stats__item--accent-ok">
              <dt>{t("dashboard.daily.kpi.completed")}</dt>
              <dd>
                {String(totals.completedTasks)}
                <span className="pk-stats__unit">{t("dashboard.daily.unit.rooms")}</span>
              </dd>
              <ProgressBar percent={totals.percentValue} label={totals.percent} />
            </div>
            <div className="pk-stats__item pk-stats__item--accent-warn">
              <dt>{t("dashboard.daily.kpi.rework")}</dt>
              <dd>
                {String(totals.reworkTasks)}
                <span className="pk-stats__unit">{t("dashboard.daily.unit.rooms")}</span>
              </dd>
            </div>
            <div className="pk-stats__item pk-stats__item--accent-warn">
              <dt>{t("dashboard.daily.kpi.attention")}</dt>
              <dd>
                {String(totals.attention + data.inspectionWaiting)}
                <span className="pk-stats__unit">{t("dashboard.daily.unit.count")}</span>
              </dd>
              <p className="pk-muted">
                {`${t("dashboard.daily.kpi.attention.breakdown")}: ${String(data.inspectionWaiting)} / ${String(totals.findingsHigh)} / ${String(totals.openIssues)}`}
              </p>
            </div>
            <div className="pk-stats__item">
              <dt>{t("dashboard.daily.kpi.properties")}</dt>
              <dd>
                {String(totals.propertyCount)}
                <span className="pk-stats__unit">{t("dashboard.daily.unit.properties")}</span>
              </dd>
              <p className="pk-muted">
                {`${String(totals.roomCount)} ${t("dashboard.daily.unit.rooms")}`}
              </p>
            </div>
          </dl>

          {/* 施設別の進捗 と 対応が必要な項目 を並置（プロトタイプの g21）。 */}
          <div className="pk-cols pk-cols--21">
            <section className="pk-panel">
              <div className="pk-panel__head">
                {t("dashboard.daily.byProperty")}
                <span className="pk-panel__note">{t("dashboard.daily.byProperty.order")}</span>
              </div>
              <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
                <table className="pk-tbl">
                  <thead>
                    <tr>
                      <th>{t("dashboard.daily.column.property")}</th>
                      <th className="pk-num">{t("dashboard.daily.column.planned")}</th>
                      <th className="pk-num">{t("dashboard.daily.column.completed")}</th>
                      <th>{t("dashboard.daily.column.progress")}</th>
                      <th className="pk-num">{t("dashboard.daily.column.attention")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.propertyId}>
                        <th scope="row">
                          <a href={`/app/p/${row.propertyId}/board`}>{row.name}</a>
                        </th>
                        <td className="pk-num">{row.hasRollup ? String(row.totalTasks) : "—"}</td>
                        <td className="pk-num">
                          {row.hasRollup ? String(row.completedTasks) : "—"}
                        </td>
                        <td>
                          {row.hasRollup ? (
                            <ProgressBar percent={row.percentValue} label={row.percent} />
                          ) : (
                            <span className="pk-muted">{t("dashboard.daily.noRollup")}</span>
                          )}
                        </td>
                        <td className="pk-num">
                          {row.attention === 0 ? (
                            "—"
                          ) : (
                            <span className="pk-badge pk-badge--warn">{String(row.attention)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>{t("dashboard.daily.total")}</td>
                      <td className="pk-num">{String(totals.totalTasks)}</td>
                      <td className="pk-num">{String(totals.completedTasks)}</td>
                      <td>{totals.percent ?? "—"}</td>
                      <td className="pk-num">{String(totals.attention)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            <section className="pk-panel">
              <div className="pk-panel__head">{t("dashboard.daily.attention.title")}</div>
              <div className="pk-panel__body">
                {/* 「通常と違う点」は断定しない語彙で述べる（ui-writing.md §2）。 */}
                <p className="pk-notice pk-notice--warn">
                  {`${t("dashboard.daily.attention.findings")}: ${String(totals.findingsHigh)}`}
                </p>
                <p className="pk-notice">
                  {`${t("dashboard.daily.attention.inspections")}: ${String(data.inspectionWaiting)}`}
                  {data.inspectionOverSla === 0
                    ? ""
                    : `（${t("dashboard.daily.attention.overSla")}: ${String(data.inspectionOverSla)}）`}
                </p>
                <p className="pk-notice">
                  {`${t("dashboard.daily.attention.issues")}: ${String(totals.openIssues)}`}
                </p>
                <p className="pk-notice pk-notice--info">
                  {`${t("dashboard.daily.attention.rework")}: ${String(totals.reworkTasks)}`}
                </p>

                <p>
                  <a className="pk-button" href="/app/audit/findings">
                    {t("dashboard.daily.open.findings")}
                  </a>{" "}
                  <a className="pk-button" href="/app/inspections/queue">
                    {t("dashboard.daily.open.inspections")}
                  </a>{" "}
                  <a className="pk-button" href="/app/ops/progress">
                    {t("dashboard.daily.open.progress")}
                  </a>
                </p>
              </div>
              {/* 月次の見え方（PK-SPEC-P5 §7.1）は別の関心。導線だけ置く。 */}
              {data.canOpenOrgDashboard ? (
                <div className="pk-panel__foot">
                  <a href="/app/org/dashboard">{t("dashboard.daily.open.monthly")}</a>
                </div>
              ) : null}
            </section>
          </div>

          {/* 直近 7 日の完了件数（プロトタイプの棒グラフ）。 */}
          <section className="pk-panel">
            <div className="pk-panel__head">
              {t("dashboard.daily.trend")}
              <span className="pk-panel__note">
                {data.trendAverage === null
                  ? ""
                  : `${t("dashboard.daily.trend.average")}: ${String(data.trendAverage)}`}
              </span>
            </div>
            <div className="pk-panel__body">
              <div className="pk-bars">
                {data.trend.map((point) => (
                  <div
                    className={`pk-bars__col${point.isCurrent ? " pk-bars__col--on" : ""}`}
                    key={point.businessDate}
                  >
                    <span className="pk-bars__value">{String(point.completedTasks)}</span>
                    <span
                      className="pk-bars__bar"
                      style={{ height: `${String(point.heightPercent)}%` }}
                    />
                    <span className="pk-bars__label">{point.businessDate.slice(5)}</span>
                  </div>
                ))}
              </div>
              <p className="pk-muted">{t("dashboard.daily.trend.note")}</p>
            </div>
          </section>
        </>
      )}
    </section>
  );
}

/**
 * 進捗バー（プロトタイプの `.bar`）。**数値を必ず併記する**
 * （契約 §1.3 MUST。色と長さだけで伝えない）。
 */
function ProgressBar({ percent, label }: { percent: number | null; label: string | null }) {
  if (percent === null) return <span className="pk-muted">—</span>;
  return (
    <span className="pk-progress">
      <span className="pk-progress__track">
        <span className="pk-progress__fill" style={{ width: `${String(percent)}%` }} />
      </span>
      <span className="pk-progress__value">{label ?? `${String(percent)}%`}</span>
    </span>
  );
}
