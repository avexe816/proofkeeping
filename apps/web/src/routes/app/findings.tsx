/**
 * W-06 差異レポート一覧（PK-SPEC-P4 §6.1）。
 *
 *   /app/audit/findings
 *
 * task:  docs/tasks/P4-06.md（2026-08-19 数字を拡張 / 2026-08-20 見た目を
 *        プロトタイプ 04 に揃える — 人間の指示 / DECISIONS #218）
 * ルール: .claude/rules/security.md §1 / .claude/rules/ui-writing.md §2
 * 参照:  ui-prototypes/owner/pkown-v3-B-findings-records.html（04 稼働の差異）
 *
 * ── `CLEANER` / `INSPECTOR` はここに到達できない ─────────
 * §6.4 MUST。`assertPermission()` が `NotFoundError` を投げ、**404** になる。
 * サイドバーからも消える（`navigation.ts` の `finding.read`）が、
 * **メニュー非表示は権限制御ではない**（security.md §1）。この loader が門。
 *
 * ── 差異は不正の認定ではない ────────────────────────────
 * §1.1 / ui-writing.md §2。画面の語彙は「差異」「要確認項目」。
 * **免責（示すこと・示さないこと）をデータより上に置く**（プロトタイプの
 * 確定事項）。
 *
 * ── 抑制を沈黙させない ──────────────────────────────────
 * §4.3。「抑制された差異 N 件」を常に出す。0 件のときも出す。
 *
 * ── 画面の骨組みはプロトタイプ 04 がそのまま正 ──────────
 * 免責の枠（`.al`）→ KPI 4 枚 → ルール別（3）と推移（1）の並置 →
 * 差異の一覧、の順。**この並びを入れ替えない。** 免責より上にデータを
 * 置かないことが、この画面の設計そのもの（プロトタイプの確定事項）。
 *
 * ── 差異率を目標として出さない ──────────────────────────
 * 一般水準（1〜3%）を併記して基準を与えるが、0% を目標として提示しない。
 * 他施設との比較・ランキングも出さない（プロトタイプの確定事項 / INV-07）。
 *
 * ── 照合済み客室・推移は施設を選んだときだけ ─────────────
 * `reconciliationRun` / 月次件数の集計は施設単位の口しか無い
 * （`listReconciliationRuns()` / `countFindingsByMonth()`）。全施設表示では
 * この 2 つを出さない。施設をまたいだ集計の口を増やさない
 * （architecture.md §3）。
 */

import type { FindingCounts, FindingSummary } from "@pk/contracts";
import {
  FINDING_STATUSES,
  countFindingsByMonth,
  listReconciliationRuns,
  recordAudit,
  type FindingSeverity,
  type FindingStatus,
} from "@pk/db";
import { findRule } from "@pk/engine";
import { Form, useLoaderData, type LoaderFunctionArgs } from "react-router";

import {
  ORGANIZATION_TARGET,
  assertPermission,
  can,
  propertyTarget,
} from "../../lib/auth/permission.js";
import { monthRangeOf } from "../../lib/baseline/dataQuality.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { listSelectableProperties, resolveSelectedScope } from "../../lib/property/selection.js";
import { collectFindingList } from "../../lib/reconciliation/findings.js";
import { SEVERITY_LABEL, STATUS_LABEL, ruleNoteLabel } from "../../lib/reconciliation/labels.js";
import { previousMonthOf } from "../../lib/report/monthly.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 推移に出す月数（プロトタイプは 6 か月）。 */
const TREND_MONTHS = 6;

/** ルール別の 1 行（プロトタイプ「ルール別の発生件数」）。 */
interface RuleRow {
  ruleCode: string;
  title: string;
  count: number;
  severity: FindingSeverity;
  averageConfidence: number;
}

/** 推移の 1 か月（差異率は照合済み客室が母数）。 */
interface TrendPoint {
  month: string;
  findingCount: number;
  roomsEvaluated: number;
  /** 千分率。母数 0 は `null`。 */
  ratePermille: number | null;
}

interface FindingsData {
  month: string;
  propertyId: string | null;
  status: FindingStatus | null;
  rows: FindingSummary[];
  counts: FindingCounts;
  suppressedCount: number;
  severityCounts: Record<FindingSeverity, number>;
  /** 対象月に照合した客室数。施設未選択・実行なしは `null`。 */
  roomsEvaluated: number | null;
  /** 差異率（千分率）。母数が無ければ `null`。 */
  ratePermille: number | null;
  /** 差異率の推移（古い月 → 対象月）。施設未選択は空。 */
  trend: TrendPoint[];
  ruleRows: RuleRow[];
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<FindingsData | Response> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  const url = new URL(request.url);
  const properties = await listSelectableProperties(env, tenant);
  const canSelectAll = can(tenant, "finding.read", ORGANIZATION_TARGET);

  // 施設はヘッダーの施設セレクタが唯一の入口（人間の指示 2026-08-19 /
  // DECISIONS #204）。画面内に同じドロップダウンを置かない。
  // 「全施設」を読めないロールがヘッダーで全社を選んでいたら既定施設へ落とす。
  const { property } = resolveSelectedScope(session.selectedPropertyId, tenant, properties);
  const propertyId = property?.id ?? (canSelectAll ? null : (properties[0]?.id ?? null));

  // **これが唯一の門。** 施設を選んでいなければ組織全体の権限を要る。
  assertPermission(
    tenant,
    "finding.read",
    propertyId === null ? ORGANIZATION_TARGET : propertyTarget([propertyId]),
  );

  const month = url.searchParams.get("month") ?? businessDateOf(now).slice(0, 7);
  const range = monthRangeOf(month);

  const statusRaw = url.searchParams.get("status");
  const status = (FINDING_STATUSES as readonly string[]).includes(statusRaw ?? "")
    ? (statusRaw as FindingStatus)
    : null;

  // **状態で絞らずに取る。** KPI（重要度別）とルール別は状態の絞りの外で
  // 数える（絞ると「確認済みにすれば KPI が減る」画面になる）。
  const list = await collectFindingList(env, tenant, {
    ...(propertyId === null ? {} : { propertyId }),
    ...(range === null ? {} : { from: range.from, to: range.to }),
  });
  const rows = status === null ? list.data : list.data.filter((row) => row.status === status);

  // ── CSV 出力（データエクスポート → 監査ログ / security.md §6）────
  if (url.searchParams.get("format") === "csv") {
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "export.data",
      targetType: "finding",
      ...(propertyId === null ? {} : { propertyId }),
      after: { month, status, count: rows.length },
    });
    return csvResponse(rows, month);
  }

  const severityCounts: Record<FindingSeverity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const row of list.data) severityCounts[row.severity] += 1;

  // ── 照合済み客室と推移（施設を選んだときだけ / 冒頭の注記）────────
  let roomsEvaluated: number | null = null;
  let ratePermille: number | null = null;
  let trend: TrendPoint[] = [];
  if (propertyId !== null && range !== null) {
    const months: string[] = [];
    let cursor = month;
    for (let index = 0; index < TREND_MONTHS; index += 1) {
      months.unshift(cursor);
      cursor = previousMonthOf(cursor);
    }
    const trendFrom = monthRangeOf(months[0] as string);

    const [runs, monthlyCounts] = await Promise.all([
      listReconciliationRuns(env, tenant, {
        propertyId,
        ...(trendFrom === null ? {} : { from: trendFrom.from }),
        to: range.to,
        limit: 400,
      }),
      trendFrom === null
        ? Promise.resolve([])
        : countFindingsByMonth(env, tenant, { propertyId, from: trendFrom.from, to: range.to }),
    ]);

    const roomsByMonth = new Map<string, number>();
    for (const run of runs) {
      const runMonth = run.businessDate.slice(0, 7);
      roomsByMonth.set(runMonth, (roomsByMonth.get(runMonth) ?? 0) + run.roomsEvaluated);
    }
    const findingsByMonth = new Map<string, number>();
    for (const entry of monthlyCounts) {
      findingsByMonth.set(entry.month, (findingsByMonth.get(entry.month) ?? 0) + entry.count);
    }

    trend = months.map((entryMonth) => {
      const findingCount = findingsByMonth.get(entryMonth) ?? 0;
      const rooms = roomsByMonth.get(entryMonth) ?? 0;
      return {
        month: entryMonth,
        findingCount,
        roomsEvaluated: rooms,
        ratePermille: rooms === 0 ? null : Math.round((findingCount * 1000) / rooms),
      };
    });

    const current = trend[trend.length - 1];
    roomsEvaluated = current === undefined || current.roomsEvaluated === 0 ? null : current.roomsEvaluated;
    ratePermille = current?.ratePermille ?? null;
  }

  // ── ルール別の発生件数（状態の絞りの外）──────────────────────────
  const byRule = new Map<string, { count: number; severities: FindingSeverity[]; confidenceSum: number }>();
  for (const row of list.data) {
    const bucket = byRule.get(row.ruleCode) ?? { count: 0, severities: [], confidenceSum: 0 };
    bucket.count += 1;
    bucket.severities.push(row.severity);
    bucket.confidenceSum += row.confidence;
    byRule.set(row.ruleCode, bucket);
  }
  const ruleRows: RuleRow[] = [...byRule.entries()]
    .map(([ruleCode, bucket]) => ({
      ruleCode,
      title: findRule(ruleCode)?.title ?? "",
      count: bucket.count,
      severity: topSeverity(bucket.severities),
      averageConfidence: Math.round(bucket.confidenceSum / bucket.count),
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.count - a.count ||
        a.ruleCode.localeCompare(b.ruleCode),
    );

  return {
    month,
    propertyId,
    status,
    rows,
    counts: list.counts,
    suppressedCount: list.suppressedCount,
    severityCounts,
    roomsEvaluated,
    ratePermille,
    trend,
    ruleRows,
  };
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function topSeverity(severities: readonly FindingSeverity[]): FindingSeverity {
  return [...severities].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? "LOW";
}

/** CSV の 1 フィールド。カンマ・引用符・改行を含むときだけ引用する。 */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * 一覧の CSV（文字列は日本語ヘッダー。表計算に渡る文書で i18n の対象外）。
 *
 * 個人名の列は無い（`FindingSummary` が持っていない / INV-06）。
 */
function csvResponse(rows: readonly FindingSummary[], month: string): Response {
  const header = ["客室", "施設", "記録日", "ルール", "重要度", "確信度", "状態", "内容"];
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.roomNumber,
        row.propertyName,
        row.businessDate,
        row.ruleCode,
        row.severity,
        String(row.confidence),
        row.status,
        row.title,
      ]
        .map(csvField)
        .join(","),
    ),
  ];
  return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="findings-${month}.csv"`,
    },
  });
}

/** 確信度の帯。プロトタイプの区分（80 以上 / 50〜79 / 50 未満）。 */
function meterClassOf(severity: FindingSeverity): string {
  return `pk-meterbar__fill pk-meterbar__fill--${severity}`;
}


/** 重要度 → タグの色（プロトタイプ 04 の `tag dg / wn / if`）。 */
const SEVERITY_TAG: Record<FindingSeverity, string> = {
  HIGH: "pk-tag pk-tag--danger",
  MEDIUM: "pk-tag pk-tag--warn",
  LOW: "pk-tag pk-tag--info",
};

/**
 * 状態 → タグの色（プロトタイプ 04 は「未確認＝灰 / 確認済み＝緑」の 2 色）。
 *
 * 実装の状態は 5 つある（§2.5）。**未対応だけを灰にし、片付いたものを緑、
 * 途中を橙にする。** 色の数を増やして「どれが急ぎか」を色で言わない。
 */
const STATUS_TAG: Record<FindingStatus, string> = {
  OPEN: "pk-tag pk-tag--muted",
  REVIEWING: "pk-tag pk-tag--warn",
  RESOLVED: "pk-tag pk-tag--ok",
  FALSE_POSITIVE: "pk-tag pk-tag--ok",
  SUPPRESSED: "pk-tag pk-tag--muted",
};

export default function Findings() {
  const data = useLoaderData<FindingsData>();
  const average = averageRateOf(data.trend);

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <div>
          <h1 className="pk-pagehead__title">{t("finding.title")}</h1>
          <p className="pk-pagehead__sub">{`${t("finding.lede")} · ${data.month}`}</p>
        </div>
        {/* プロトタイプは期間セレクタと CSV を見出しの右端に置く。 */}
        <div className="pk-pagehead__actions">
          <Form method="get" className="pk-filter">
            <label className="pk-field">
              <span className="pk-field__label">{t("finding.filter.month")}</span>
              <input className="pk-input" type="month" name="month" defaultValue={data.month} />
            </label>

            <label className="pk-field">
              <span className="pk-field__label">{t("finding.filter.status")}</span>
              <select className="pk-select" name="status" defaultValue={data.status ?? ""}>
                <option value="">{t("finding.filter.allStatuses")}</option>
                {FINDING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(STATUS_LABEL[status])}
                  </option>
                ))}
              </select>
            </label>

            <button className="pk-button pk-button--primary" type="submit">
              {t("finding.filter.apply")}
            </button>
            {/* CSV は同じ絞り込みで出力する（データエクスポートとして監査ログに残る）。 */}
            <button className="pk-button" type="submit" name="format" value="csv">
              {t("finding.exportCsv")}
            </button>
          </Form>
        </div>
      </div>

      {/* §1.1。**免責をデータより上に置く**（プロトタイプの確定事項）。
          この 1 枚が無いと、確信度 92 が有罪の判定として読まれる。 */}
      <div className="pk-alert pk-alert--info">
        <span className="pk-alert__icon" aria-hidden="true">
          ℹ
        </span>
        <p>
          <b className="pk-alert__title">{t("finding.disclaimer.title")}</b>
          {t("finding.intro")}
        </p>
      </div>

      {/* ── KPI（プロトタイプの 4 枚）──────────────────────── */}
      <dl className="pk-stats pk-stats--4">
        <div className="pk-stats__item pk-stats__item--accent-danger">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              🔴
            </span>
            {t("finding.kpi.high")}
          </dt>
          <dd>
            {String(data.severityCounts.HIGH)}
            <span className="pk-stats__unit">{t("finding.unit.count")}</span>
          </dd>
          <p className="pk-report__delta">{t("finding.kpi.highNote")}</p>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-warn">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              🟠
            </span>
            {t("finding.kpi.medium")}
          </dt>
          <dd>
            {String(data.severityCounts.MEDIUM)}
            <span className="pk-stats__unit">{t("finding.unit.count")}</span>
          </dd>
          <p className="pk-report__delta">{t("finding.kpi.mediumNote")}</p>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-info">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              🔵
            </span>
            {t("finding.kpi.low")}
          </dt>
          <dd>
            {String(data.severityCounts.LOW)}
            <span className="pk-stats__unit">{t("finding.unit.count")}</span>
          </dd>
          <p className="pk-report__delta">{t("finding.kpi.lowNote")}</p>
        </div>
        <div className="pk-stats__item pk-stats__item--accent-ok">
          <dt>
            <span className="pk-stats__icon" aria-hidden="true">
              ✓
            </span>
            {t("finding.kpi.evaluated")}
          </dt>
          <dd>
            {data.roomsEvaluated === null ? "—" : String(data.roomsEvaluated)}
            {data.roomsEvaluated === null ? null : (
              <span className="pk-stats__unit">{t("finding.unit.rooms")}</span>
            )}
          </dd>
          <p className="pk-report__delta">
            {data.ratePermille === null
              ? t("finding.kpi.evaluatedNone")
              : `${t("finding.kpi.rate")} ${formatPermille(data.ratePermille)}`}
          </p>
        </div>
      </dl>

      {/* ── ルール別（広い）と差異率の推移（狭い）を並置（`.g31`）──── */}
      {data.ruleRows.length === 0 && data.trend.length === 0 ? null : (
        <div className={data.trend.length === 0 ? "pk-cols" : "pk-cols pk-cols--31"}>
          {data.ruleRows.length === 0 ? null : (
            <section className="pk-panel">
              <div className="pk-panel__head">
                <span className="pk-panel__icon" aria-hidden="true">
                  📊
                </span>
                {t("finding.byRule.title")}
                <span className="pk-panel__note">{data.month}</span>
              </div>
              <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
                <table className="pk-tbl">
                  <thead>
                    <tr>
                      <th>{t("finding.byRule.rule")}</th>
                      <th>{t("finding.byRule.content")}</th>
                      <th className="pk-num">{t("finding.byRule.count")}</th>
                      <th>{t("finding.column.severity")}</th>
                      <th>{t("finding.byRule.averageConfidence")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ruleRows.map((rule) => {
                      const note = ruleNoteLabel(rule.ruleCode);
                      return (
                        <tr key={rule.ruleCode}>
                          <th scope="row">{rule.ruleCode}</th>
                          <td>
                            {rule.title}
                            {note === null ? null : <p className="pk-cellnote">{t(note)}</p>}
                          </td>
                          <td className="pk-num">{String(rule.count)}</td>
                          <td>
                            <span className={SEVERITY_TAG[rule.severity]}>
                              {t(SEVERITY_LABEL[rule.severity])}
                            </span>
                          </td>
                          <td>
                            <span className="pk-meterbar">
                              <span className="pk-meterbar__track">
                                <i
                                  className={meterClassOf(rule.severity)}
                                  style={{ width: `${String(rule.averageConfidence)}%` }}
                                />
                              </span>
                              {String(rule.averageConfidence)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 施設を選んだときだけ（冒頭の注記）。 */}
          {data.trend.length === 0 ? null : (
            <section className="pk-panel">
              <div className="pk-panel__head">
                <span className="pk-panel__icon" aria-hidden="true">
                  📈
                </span>
                {t("finding.trend.title")}
              </div>
              <div className="pk-panel__body">
                <div className="pk-bars">
                  {data.trend.map((point) => (
                    <div
                      key={point.month}
                      className={
                        point.month === data.month ? "pk-bars__col pk-bars__col--on" : "pk-bars__col"
                      }
                    >
                      <span className="pk-bars__value">
                        {point.ratePermille === null ? "—" : formatPermille(point.ratePermille)}
                      </span>
                      <i
                        className="pk-bars__bar"
                        style={{ height: `${String(barHeight(point, data.trend))}%` }}
                      />
                      <span className="pk-bars__label">{point.month.slice(5)}</span>
                    </div>
                  ))}
                </div>
                {/* 0% を目標にしない（冒頭の注記）。**他施設と比べない。**
                    出すのは自施設の平均と、業界の一般的な水準だけ。 */}
                <p className="pk-barsnote">
                  {average === null ? null : (
                    <span>
                      {`${t("finding.trend.average")} `}
                      <b>{formatPermille(average)}</b>
                    </span>
                  )}
                  <span>
                    {`${t("finding.trend.benchmarkLabel")} `}
                    <b>{t("finding.trend.benchmarkValue")}</b>
                  </span>
                </p>
              </div>
              <div className="pk-panel__foot">{t("finding.trend.note")}</div>
            </section>
          )}
        </div>
      )}

      {/* ── 差異の一覧 ─────────────────────────────────────── */}
      <section className="pk-panel">
        <div className="pk-panel__head">
          <span className="pk-panel__icon" aria-hidden="true">
            ⚠️
          </span>
          {t("finding.list.title")}
          <span className="pk-panel__note">{t("finding.list.order")}</span>
        </div>

        {data.rows.length === 0 ? (
          <div className="pk-panel__body">
            <p className="pk-muted">{t("finding.empty")}</p>
          </div>
        ) : (
          <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
            <table className="pk-tbl">
              <thead>
                <tr>
                  <th>{t("finding.column.room")}</th>
                  <th>{t("finding.column.date")}</th>
                  <th>{t("finding.column.property")}</th>
                  <th>{t("finding.column.rule")}</th>
                  <th>{t("finding.column.title")}</th>
                  <th>{t("finding.column.confidence")}</th>
                  <th>{t("finding.column.status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.roomNumber}</th>
                    <td>{row.businessDate}</td>
                    <td>{row.propertyName}</td>
                    <td>
                      <span className="pk-rulecell">
                        <span className="pk-rulecell__code">{row.ruleCode}</span>
                        <span className="pk-rulecell__name">
                          {findRule(row.ruleCode)?.title ?? ""}
                        </span>
                      </span>
                    </td>
                    <td>{row.title}</td>
                    {/* §1.3 MUST。**確信度を必ず示す。** */}
                    <td>
                      <span className="pk-meterbar">
                        <span className="pk-meterbar__track">
                          <i
                            className={meterClassOf(row.severity)}
                            style={{ width: `${String(row.confidence)}%` }}
                          />
                        </span>
                        {String(row.confidence)}
                      </span>
                    </td>
                    <td>
                      <span className={STATUS_TAG[row.status]}>{t(STATUS_LABEL[row.status])}</span>
                    </td>
                    <td>
                      <a className="pk-button" href={`/app/audit/findings/${row.id}`}>
                        {t("finding.open")}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 状態別の件数は**絞り込みの外側**（「確認済みにすれば減る」数字に
            しない）。プロトタイプは持たないが、絞りを掛けた画面で全体の
            件数が読めなくなるため残す。 */}
        <div className="pk-panel__foot">
          {`${t("finding.counts.title")}: ${(["OPEN", "REVIEWING", "RESOLVED", "FALSE_POSITIVE"] as const)
            .map((status) => `${t(STATUS_LABEL[status])} ${String(data.counts[status])}`)
            .join(" / ")}`}
        </div>

        {/* §4.3。**0 件でも出す。** 抑制を沈黙させない。 */}
        <div className="pk-panel__foot">
          {`${t("finding.suppressed")}: ${String(data.suppressedCount)}`}
          <p className="pk-cellnote">{t("finding.suppressedNote")}</p>
        </div>
      </section>
    </section>
  );
}

/** 千分率を「1.3%」の形に。**桁を増やさない**（0.1% 刻みで足りる）。 */
function formatPermille(permille: number): string {
  return `${(permille / 10).toFixed(1)}%`;
}

/** 推移の平均（千分率）。母数のある月だけで割る。1 つも無ければ `null`。 */
function averageRateOf(trend: readonly TrendPoint[]): number | null {
  const values = trend.map((point) => point.ratePermille).filter((value) => value !== null);
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** 棒の高さ（%）。最大値を 96% に正規化する。母数の無い月は 4%。 */
function barHeight(point: TrendPoint, trend: readonly TrendPoint[]): number {
  const max = Math.max(...trend.map((entry) => entry.ratePermille ?? 0));
  if (point.ratePermille === null || max === 0) return 4;
  return Math.max(6, Math.round((point.ratePermille * 96) / max));
}
