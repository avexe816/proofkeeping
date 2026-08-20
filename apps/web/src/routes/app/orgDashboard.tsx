import { ALL_PROPERTIES, monthSchema, type OrgDashboardResponse } from "@pk/contracts";
import { listAuditLogsForViewer } from "@pk/db";
import { Form, redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { ORGANIZATION_TARGET, can } from "../../lib/auth/permission.js";
import { DEFAULT_DAY_CUTOFF_TIME, businessDateOf } from "../../lib/businessDate.js";
import { buildOrgDashboard, currentMonthOf } from "../../lib/dashboard/org.js";
import {
  costPerTask,
  formatAverageMinutes,
  formatPercent,
  formatYen,
  orDash,
} from "../../lib/dashboard/format.js";
import { buildTimeline, type TimelineRow } from "../../lib/dashboard/timeline.js";
import { t } from "../../lib/i18n.js";
import { formatClock } from "../../lib/mobile/format.js";
import { ScopeForbiddenError, switchProperty } from "../../lib/property/selection.js";
import { collectFindingList } from "../../lib/reconciliation/findings.js";
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

  const dashboard = await buildOrgDashboard(env, tenant, month);

  // ── 気づきカードと本日の動き（owner 02 の残り / PROTOTYPE_GAP）────
  // 門は `finding.read`。この画面に来られる組織全体ロールは全員持つが、
  // 判定はマトリクスに委ねる（ロール名で分岐しない / listScope.ts と同じ）。
  // 持たない相手には**カードごと出さない**（グレーにしない）。
  if (!can(tenant, "finding.read", ORGANIZATION_TARGET)) {
    return { ...dashboard, attention: [], timeline: [] };
  }

  // 「本日」は業務日（architecture.md §7）。既定の日締め 05:00 Asia/Tokyo で
  // 窓を作る。施設ごとの日締め設定までは見ない（組織横断の 1 枚なので、
  // どれか 1 施設の設定を全体へ当てるほうが誤りが大きい）。
  const businessDate = businessDateOf(now);
  const dayStart = new Date(`${businessDate}T${DEFAULT_DAY_CUTOFF_TIME}:00+09:00`);

  const [findingList, logs] = await Promise.all([
    // 未確認の差異だけ。件数は少ないので月で絞らない（古い未確認も見せる）。
    collectFindingList(env, tenant, { status: ["OPEN", "REVIEWING"], limit: 50 }),
    listAuditLogsForViewer(env, tenant, {
      propertyIds: null,
      from: dayStart,
      to: now,
      limit: 200,
    }),
  ]);

  const nameOf = new Map(dashboard.properties.map((row) => [row.propertyId, row.name]));

  // プロトタイプの並びは**確信度の高い順**（§1.3 MUST の値をそのまま使う）。
  const attention = [...findingList.data]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, ATTENTION_LIMIT)
    .map((finding) => ({
      id: finding.id,
      propertyName: finding.propertyName,
      roomNumber: finding.roomNumber,
      title: finding.title,
      confidence: finding.confidence,
      businessDate: finding.businessDate,
    }));

  const timeline = buildTimeline(logs, nameOf, TIMELINE_LIMIT);

  return { ...dashboard, attention, timeline };
}

/** 気づきカードの行数。多いと「全部あとで」になる。続きは差異レポートへ。 */
const ATTENTION_LIMIT = 5;

/** 本日の動きの行数。 */
const TIMELINE_LIMIT = 10;

interface AttentionRow {
  id: string;
  propertyName: string;
  roomNumber: string;
  title: string;
  confidence: number;
  businessDate: string;
}

type OrgDashboardData = OrgDashboardResponse & {
  attention: AttentionRow[];
  timeline: TimelineRow[];
};

export default function OrgDashboard() {
  const data = useLoaderData<OrgDashboardData>();
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

      {/* ── 気づきカード（owner 02 / 確認をお願いしたい記録）─────────
          文言は断定しない。差異の title は engine が「記録された事実」の
          形で作る（§1.1 / ui-writing.md §2）。個人名を出さない。 */}
      <h2 className="pk-section__title">{t("dashboard.org.attention")}</h2>
      <p className="pk-muted">{t("dashboard.org.attention.order")}</p>
      {data.attention.length === 0 ? (
        <p className="pk-muted">{t("dashboard.org.attention.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("dashboard.org.attention.property")}</th>
              <th>{t("dashboard.org.attention.room")}</th>
              <th>{t("dashboard.org.attention.content")}</th>
              <th>{t("dashboard.org.attention.confidence")}</th>
              <th>{t("dashboard.org.attention.date")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.attention.map((row) => (
              <tr key={row.id}>
                <td>{row.propertyName}</td>
                <th scope="row">{row.roomNumber}</th>
                <td>{row.title}</td>
                <td>{String(row.confidence)}</td>
                <td>{row.businessDate}</td>
                <td>
                  <a className="pk-button" href={`/app/audit/findings/${row.id}`}>
                    {t("dashboard.org.attention.open")}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
            {/* `href` の無い行は施設単位の画面（W-09 / W-10）。全社ビューでは
                施設が決まらないため件数だけを出す（`actionRows()` の注記）。 */}
            {row.href === null ? null : (
              <a className="pk-button" href={row.href}>
                {t("dashboard.org.action.open")}
              </a>
            )}
          </li>
        ))}
      </ul>

      {/* ── 本日の動き（owner 02 のタイムライン）──────────────────
          監査ログから現場の操作だけを拾う（`TIMELINE_EVENT_LABEL`）。
          実行者は出さない。詳細は監査ログの画面（P7-20）へ。 */}
      <h2 className="pk-section__title">{t("dashboard.org.timeline")}</h2>
      {data.timeline.length === 0 ? (
        <p className="pk-muted">{t("dashboard.org.timeline.empty")}</p>
      ) : (
        <ul className="pk-timeline">
          {data.timeline.map((row) => (
            <li className="pk-timeline__item" key={row.id}>
              <span className="pk-timeline__time">{formatClock(row.at)}</span>
              <span>{t(row.label)}</span>
              <span className="pk-timeline__property">
                {row.propertyName ?? t("auditLogs.orgWide")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 要対応の 4 行（§7.1 の下段）。
 *
 * ── リンク先がある行と無い行がある ──────────────────────
 * 差異レポート（W-06 / P4-06）と請求期間（P5-19）は組織横断の画面へ
 * リンクする。**忘れ物（W-09）・設備不具合（W-10）は施設単位の画面**
 * （P7-22 / PK-SPEC-P2 §12.1 のパスが `/app/p/[id]/…`）で、全社ビューの
 * この画面からは施設が決まらないため件数だけを出す。到達はサイドバー
 * （施設を選んだ状態）から。
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
      // P5-19 が請求確認の画面を作った（OPEN_QUESTIONS #082 の請求期間分）。
      href: "/app/billing-periods",
    },
  ] as const;
}
