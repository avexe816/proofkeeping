import type { PropertySummary } from "@pk/contracts";

import { t } from "../lib/i18n.js";

/**
 * 施設サマリーの一覧（全社ビュー）。
 *
 * task: docs/tasks/P0-21.md
 * 仕様: docs/PK-SPEC-P0.md §23.3
 *
 * ── 集計が無い施設に 0 を出さない ───────────────────────
 * `hasRollup` が偽なら数字を出さず「集計はまだありません」と述べる。
 * **0 と表示すると、清掃が 1 件も終わっていないように読める。**
 * P0 の間は `cleaningTask` が無いので、常にこちらの表示になる。
 *
 * ── 列名は rollup の語彙 ────────────────────────────────
 * §23.3 の例は `清掃済 / 作業中 / 未清掃`（客室の状態）だが、rollup が
 * 持つのはタスクの数。対応が仕様に無いので**数えたものの名前で出す**
 * （OPEN_QUESTIONS #023）。
 */
export function PropertySummaryTable(props: { summaries: readonly PropertySummary[] }) {
  if (props.summaries.length === 0) {
    return <p className="pk-summary pk-summary--empty">{t("property.none")}</p>;
  }

  return (
    <table className="pk-summary">
      <thead>
        <tr>
          <th scope="col">{t("property.current")}</th>
          <th scope="col">{t("property.roomCount")}</th>
          <th scope="col">{t("property.summary.ready")}</th>
          <th scope="col">{t("property.summary.inProgress")}</th>
          <th scope="col">{t("property.summary.openFindings")}</th>
        </tr>
      </thead>
      <tbody>
        {props.summaries.map((summary) => (
          <tr key={summary.propertyId}>
            <th scope="row">{summary.name}</th>
            <td>{summary.roomCount}</td>
            {summary.hasRollup ? (
              <>
                <td>{summary.completedTasks}</td>
                <td>{summary.totalTasks - summary.completedTasks}</td>
                <td>{summary.openIssues}</td>
              </>
            ) : (
              <td colSpan={3}>{t("property.summary.unavailable")}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
