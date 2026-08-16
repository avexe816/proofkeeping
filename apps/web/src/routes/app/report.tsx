/**
 * 月次レポート（owner 09）。
 *
 *   /app/p/:propertyId/report?month=YYYY-MM
 *
 * 台帳:  docs/PROTOTYPE_GAP.md 第2批 09 / DECISIONS #196
 * 参照:  ui-prototypes/owner/pkown-v3-C-inspection-linen-report.html（09）
 * ルール: .claude/rules/security.md §1・§5 / .claude/rules/ui-writing.md §2
 *
 * ── 門は `finding.read` ─────────────────────────────────
 * §3 に差異のルール別内訳が載る。差異へ到達できない `CLEANER` /
 * `INSPECTOR` には**レポートごと 404**（security.md §1。403 は存在を
 * 示唆する）。監査ログの閲覧（P7-20）と同じ判断で、新しい権限区分を
 * 作らない。
 *
 * ── 確定・発行をしない（DECISIONS #196）──────────────────
 * プロトタイプの「毎月5日に自動で確定・PDFで保存」は実装しない。
 * 開いた時点の記録から毎回作り直す画面で、帳票番号もスナップショットも
 * 持たない。紙にするときはブラウザの印刷機能を使う（DECISIONS #184 の
 * 案内カードと同じ）。`@media print` でレポート本体だけが紙に残る。
 *
 * ── 評価の道具にしない ──────────────────────────────────
 * 個人・階の内訳を出さない（INV-03 / security.md §5）。差異率・再清掃率を
 * 0% 目標の指標として出さない（プロトタイプの但し書きを常設）。
 */

import { NotFoundError } from "@pk/db";
import { findRule, type MonthlyReport } from "@pk/engine";
import { Form, useLoaderData, type LoaderFunctionArgs } from "react-router";

import { assertPermission, propertyTarget } from "../../lib/auth/permission.js";
import { monthRangeOf } from "../../lib/baseline/dataQuality.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t } from "../../lib/i18n.js";
import { listSelectableProperties, switchProperty } from "../../lib/property/selection.js";
import { SEVERITY_LABEL } from "../../lib/reconciliation/labels.js";
import { collectMonthlyReport, previousMonthOf } from "../../lib/report/monthly.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";
import type { MessageKey } from "../../lib/i18n.js";

interface MonthlyReportData {
  report: MonthlyReport;
  propertyName: string;
}

/** 作業種別の文言。**現場画面（M-05 ほか）と同じキーを引く**（訳を増やさない）。 */
const TASK_TYPE_LABEL: Record<string, MessageKey> = {
  CHECKOUT: "m.taskType.CHECKOUT",
  STAYOVER: "m.taskType.STAYOVER",
  DEEP: "m.taskType.DEEP",
  COMMON_AREA: "m.taskType.COMMON_AREA",
  RECHECK: "m.taskType.RECHECK",
};

export async function loader({
  request,
  params,
  context,
}: LoaderFunctionArgs): Promise<MonthlyReportData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant, cookieValue } = await requireAppContext(env, request, now);

  const propertyId = params["propertyId"];
  if (propertyId === undefined) throw new NotFoundError();

  // URL を正としてセッションを更新する（W-22 データ品質と同じ）。
  await switchProperty(env, tenant, cookieValue, propertyId, now, session.membershipId);

  assertPermission(tenant, "finding.read", propertyTarget([propertyId]));

  // 既定は**前月**。月の途中の数字は動き続けるので、既定では締まった月を出す。
  const requested = new URL(request.url).searchParams.get("month");
  const month = requested ?? previousMonthOf(businessDateOf(now).slice(0, 7));
  const range = monthRangeOf(month);
  if (range === null) throw new NotFoundError();

  const [report, properties] = await Promise.all([
    collectMonthlyReport(env, tenant, { propertyId, month, range }),
    listSelectableProperties(env, tenant),
  ]);

  return {
    report,
    propertyName: properties.find((property) => property.id === propertyId)?.name ?? "",
  };
}

export default function MonthlyReportScreen() {
  const { report, propertyName } = useLoaderData<MonthlyReportData>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead pk-print__hide">
        <h1 className="pk-pagehead__title">{t("report.title")}</h1>
      </div>

      <p className="pk-notice pk-print__hide">{t("report.intro")}</p>

      <Form method="get" className="pk-filter pk-print__hide">
        <label className="pk-field">
          <span className="pk-field__label">{t("report.filter.month")}</span>
          <input className="pk-input" type="month" name="month" defaultValue={report.month} />
        </label>
        <button className="pk-button" type="submit">
          {t("report.filter.apply")}
        </button>
      </Form>
      <p className="pk-muted pk-print__hide">{t("report.printHint")}</p>

      <div className="pk-print pk-report">
        <header className="pk-report__head">
          <h2 className="pk-report__title">{`${report.month} ${t("report.title")}`}</h2>
          <p className="pk-muted">{`${propertyName} · ${report.from} 〜 ${report.to}`}</p>
        </header>

        {/* ── §1 今月の概要 ─────────────────────────────── */}
        <h2 className="pk-section__title">{t("report.section.summary")}</h2>
        <dl className="pk-stats">
          <div className="pk-stats__item">
            <dt>{t("report.summary.completed")}</dt>
            <dd>{String(report.summary.completedTasks.count)}</dd>
            <Delta permille={report.summary.completedTasks.changePermille} unit="percent" />
          </div>
          <div className="pk-stats__item">
            <dt>{t("report.summary.recordRate")}</dt>
            <dd>
              {formatPermille(report.summary.recordRate.rate.permille)}
              <span className="pk-stats__unit">{t("report.unit.percent")}</span>
            </dd>
            <Delta permille={report.summary.recordRate.changePermille} unit="point" />
          </div>
          <div className="pk-stats__item">
            <dt>{t("report.summary.findingRate")}</dt>
            <dd>
              {formatPermille(report.summary.findingRate.rate.permille)}
              <span className="pk-stats__unit">{t("report.unit.percent")}</span>
            </dd>
            <Delta permille={report.summary.findingRate.changePermille} unit="point" />
          </div>
          <div className="pk-stats__item">
            <dt>{t("report.summary.reworkRate")}</dt>
            <dd>
              {formatPermille(report.summary.reworkRate.rate.permille)}
              <span className="pk-stats__unit">{t("report.unit.percent")}</span>
            </dd>
            <Delta permille={report.summary.reworkRate.changePermille} unit="point" />
          </div>
        </dl>
        {/* 0% 目標の指標にしない（プロトタイプの但し書き / findings 画面と同じ判断）。 */}
        <p className="pk-muted">{t("report.summary.note")}</p>

        {/* ── §2 清掃の実施状況 ─────────────────────────── */}
        <h2 className="pk-section__title">{t("report.section.taskTypes")}</h2>
        {report.taskTypes.length === 0 ? (
          <p className="pk-muted">{t("report.taskTypes.empty")}</p>
        ) : (
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("report.taskTypes.type")}</th>
                <th>{t("report.taskTypes.count")}</th>
                <th>{t("report.taskTypes.median")}</th>
              </tr>
            </thead>
            <tbody>
              {report.taskTypes.map((row) => (
                <tr key={row.taskType}>
                  <th scope="row">{labelOfTaskType(row.taskType)}</th>
                  <td>{String(row.completedCount)}</td>
                  <td>
                    {row.medianMinutes === null
                      ? NO_VALUE
                      : `${String(row.medianMinutes)}${t("report.unit.minutes")}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* ── §3 稼働の差異 ─────────────────────────────── */}
        <h2 className="pk-section__title">{t("report.section.findings")}</h2>
        {report.findingsByRule.length === 0 ? (
          <p className="pk-muted">{t("report.findings.empty")}</p>
        ) : (
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("report.findings.rule")}</th>
                <th>{t("report.findings.severity")}</th>
                <th>{t("report.findings.count")}</th>
                <th>{t("report.findings.reviewed")}</th>
              </tr>
            </thead>
            <tbody>
              {report.findingsByRule.map((row) => (
                <tr key={row.ruleCode}>
                  <th scope="row">{`${row.ruleCode} ${findRule(row.ruleCode)?.title ?? ""}`}</th>
                  <td>{labelOfSeverity(row.severity)}</td>
                  <td>{String(row.totalCount)}</td>
                  <td>{`${String(row.reviewedCount)} / ${String(row.totalCount)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* ── §4 検査と再清掃 ───────────────────────────── */}
        <h2 className="pk-section__title">{t("report.section.inspection")}</h2>
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("report.inspection.item")}</th>
              <th>{t("report.inspection.count")}</th>
              <th>{t("report.inspection.note")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{t("report.inspection.inspected")}</th>
              <td>{String(report.inspection.inspectedTasks)}</td>
              <td>
                {report.inspection.inspectionCoverage.permille === null
                  ? NO_VALUE
                  : `${t("report.inspection.coverageNote")} ${formatPermille(report.inspection.inspectionCoverage.permille)}${t("report.unit.percent")}`}
              </td>
            </tr>
            <tr>
              <th scope="row">{t("report.inspection.passed")}</th>
              <td>{String(report.inspection.passedTasks)}</td>
              <td>
                {report.inspection.passRate.permille === null
                  ? NO_VALUE
                  : `${t("report.inspection.passNote")} ${formatPermille(report.inspection.passRate.permille)}${t("report.unit.percent")}`}
              </td>
            </tr>
            <tr>
              <th scope="row">{t("report.inspection.rework")}</th>
              <td>{String(report.inspection.reworkTasks)}</td>
              <td>
                {report.summary.reworkRate.rate.permille === null
                  ? NO_VALUE
                  : `${t("report.inspection.reworkNote")} ${formatPermille(report.summary.reworkRate.rate.permille)}${t("report.unit.percent")}`}
              </td>
            </tr>
          </tbody>
        </table>

        {/* ── §5 リネンの消費 ───────────────────────────── */}
        <h2 className="pk-section__title">{t("report.section.linen")}</h2>
        {report.linen.length === 0 ? (
          <p className="pk-muted">{t("report.linen.empty")}</p>
        ) : (
          <table className="pk-grid">
            <thead>
              <tr>
                <th>{t("report.linen.item")}</th>
                <th>{t("report.linen.collected")}</th>
                <th>{t("report.linen.supplied")}</th>
                <th>{t("report.linen.delta")}</th>
              </tr>
            </thead>
            <tbody>
              {report.linen.map((row) => (
                <tr key={row.itemCode}>
                  <th scope="row">{labelOfItem(row.itemCode)}</th>
                  <td>{String(row.collectedQty)}</td>
                  <td>{String(row.suppliedQty)}</td>
                  <td>{formatDelta(row.delta)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t("report.linen.total")}</th>
                <td>{String(report.linenTotals.collectedQty)}</td>
                <td>{String(report.linenTotals.suppliedQty)}</td>
                <td>{formatDelta(report.linenTotals.delta)}</td>
              </tr>
            </tfoot>
          </table>
        )}

        {/* フッターの但し書き 3 つ。**消さないこと**（プロトタイプの MUST）。 */}
        <footer className="pk-report__footer">
          <p className="pk-muted">{t("report.footer.generated")}</p>
          <p className="pk-muted">{t("report.footer.notForReview")}</p>
          <p className="pk-muted">{t("report.footer.notJudgement")}</p>
        </footer>
      </div>
    </section>
  );
}

/** 母数が無いときの表示。**0 と区別する**（W-22 と同じ）。 */
const NO_VALUE = "—";

/** 千分率を「97.8」へ（単位は呼び出し側が付ける）。 */
function formatPermille(permille: number | null): string {
  return permille === null ? NO_VALUE : (permille / 10).toFixed(1);
}

/** 差分の符号付き表示（+34 / -2 / 0）。 */
function formatDelta(delta: number): string {
  return delta > 0 ? `+${String(delta)}` : String(delta);
}

/** 前月比 1 行。**前月が無ければ行ごと出さない**（±0% と区別する）。 */
function Delta({ permille, unit }: { permille: number | null; unit: "percent" | "point" }) {
  if (permille === null) return null;
  const signed = permille > 0 ? `+${(permille / 10).toFixed(1)}` : (permille / 10).toFixed(1);
  return (
    <p className="pk-report__delta">
      {`${t("report.delta.label")} ${signed}${t(unit === "percent" ? "report.unit.percent" : "report.unit.point")}`}
    </p>
  );
}

function labelOfTaskType(taskType: string): string {
  const key = TASK_TYPE_LABEL[taskType];
  return key === undefined ? taskType : t(key);
}

function labelOfSeverity(severity: string): string {
  const key = (SEVERITY_LABEL as Partial<Record<string, MessageKey>>)[severity];
  return key === undefined ? severity : t(key);
}

/** 品目の文言。**観察記録の品目キー（`obs.item.*`）を引く**（訳を増やさない）。 */
function labelOfItem(itemCode: string): string {
  const key = `obs.item.${itemCode}`;
  return t(key as MessageKey);
}
