/**
 * 月次監査レポート PDF のテンプレート（PK-SPEC-P4 §7）。
 *
 * task:  docs/tasks/P4-14.md
 * ルール: .claude/rules/ui-writing.md §2（禁止語）/ architecture.md §5
 *
 * ── 免責事項は差し替えられない（§7.2 MUST）─────────────
 * **`AUDIT_REPORT_DISCLAIMER` を直に読む。** payload の
 * `disclaimer` を経由していないのは意図で、payload を作る側が
 * 何を入れてもここは定数を出す。**この行を `payload.disclaimer` に
 * 書き換えないこと。** §7.2 の「削除・編集できない実装」の実体がここ。
 *
 * ── JSX を使っていない ──────────────────────────────────
 * 日報（`dailyReport.ts`）と同じ理由。冒頭の注記を参照。
 *
 * ── 数値を再計算しない ──────────────────────────────────
 * 出すのは payload の値そのまま。集計は `@pk/engine` の
 * `buildAuditReportPayload()` だけが行う。
 */

import { AUDIT_REPORT_DISCLAIMER, type AuditReportPayload } from "@pk/engine";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";

import { formatCount } from "./format.js";
import { AUDIT_REPORT_LABELS, SEVERITY_LABELS, FINDING_STATUS_LABELS, labelOf } from "./labels.js";

/** 日報と同じ制約（`DailyReportFont` の注記）。 */
export type AuditReportFont =
  | { kind: "EMBEDDED"; family: string; dataUrl: string }
  | { kind: "BUILT_IN_LATIN" };

export type AuditReportDocument = Parameters<
  typeof import("@react-pdf/renderer").renderToBuffer
>[0];

const styles = StyleSheet.create({
  page: { paddingTop: 32, paddingBottom: 32, paddingHorizontal: 32, fontSize: 9 },
  title: { fontSize: 16, marginBottom: 10 },
  metaRow: { flexDirection: "row", marginBottom: 2 },
  metaLabel: { width: 88 },
  sectionTitle: { fontSize: 12, marginTop: 14, marginBottom: 4 },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#999999",
    paddingVertical: 3,
  },
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#333333",
    paddingVertical: 3,
  },
  cell: { paddingRight: 4 },
  summaryRow: { flexDirection: "row", paddingVertical: 2 },
  summaryLabel: { width: 132 },
  indented: { width: 132, paddingLeft: 12 },
  empty: { paddingVertical: 4 },
  disclaimer: { marginTop: 8, fontSize: 8, lineHeight: 1.5 },
});

/** 各表の列幅（合計 100）。 */
const TREND_WIDTHS = [28, 24, 24, 24] as const;
const FINDING_WIDTHS = [16, 10, 10, 34, 14, 16] as const;
const RULE_WIDTHS = [12, 40, 16, 16, 16] as const;

function cell(text: string, widthPercent: number, key: string): ReactElement {
  return createElement(
    View,
    { key, style: [styles.cell, { width: `${String(widthPercent)}%` }] },
    createElement(Text, null, text),
  );
}

function row(cells: readonly string[], widths: readonly number[], key: string, header = false) {
  return createElement(
    View,
    { key, style: header ? styles.headerRow : styles.row, wrap: false },
    ...cells.map((value, index) => cell(value, widths[index] ?? 10, `${key}-${String(index)}`)),
  );
}

/** 見出し行 + 本文行。**0 行なら「該当なし」**（節ごと消さない）。 */
function table(
  columns: readonly string[],
  widths: readonly number[],
  rows: readonly (readonly string[])[],
  keyPrefix: string,
): ReactElement {
  if (rows.length === 0) {
    return createElement(
      View,
      { style: styles.empty },
      createElement(Text, null, AUDIT_REPORT_LABELS.none),
    );
  }
  return createElement(
    View,
    null,
    row(columns, widths, `${keyPrefix}-head`, true),
    ...rows.map((values, index) => row(values, widths, `${keyPrefix}-${String(index)}`)),
  );
}

function metaLine(label: string, value: string, key: string): ReactElement {
  return createElement(
    View,
    { key, style: styles.metaRow },
    createElement(Text, { style: styles.metaLabel }, label),
    createElement(Text, null, value),
  );
}

function summaryLine(label: string, value: string, key: string, indented = false): ReactElement {
  return createElement(
    View,
    { key, style: styles.summaryRow },
    createElement(Text, { style: indented ? styles.indented : styles.summaryLabel }, label),
    createElement(Text, null, value),
  );
}

function sectionTitle(text: string, key: string): ReactElement {
  return createElement(Text, { key, style: styles.sectionTitle }, text);
}

/** 千分率を「25.0%」へ。**母数が無ければ「—」**（0% と区別する）。 */
function formatPermille(permille: number | null): string {
  return permille === null ? AUDIT_REPORT_LABELS.noValue : `${(permille / 10).toFixed(1)}%`;
}

/**
 * 月次監査レポートの React 要素を組む。**描画は `render.ts`。**
 *
 * 節の並びは §7.1 のとおり 1〜6。**節を減らさないこと**
 * （該当が無い節は「該当なし」を出す）。
 */
export function buildAuditReportDocument(
  payload: AuditReportPayload,
  font: AuditReportFont,
): AuditReportDocument {
  const fontFamily = font.kind === "EMBEDDED" ? font.family : "Helvetica";

  const trendRows = payload.trend.map((month) => [
    month.month,
    formatCount(month.high),
    formatCount(month.medium),
    formatCount(month.low),
  ]);

  const findingRow = (line: AuditReportPayload["highFindings"][number]): string[] => [
    line.businessDate,
    line.roomNumber,
    line.ruleCode,
    line.title,
    `${formatCount(line.confidence)}%`,
    labelOf(FINDING_STATUS_LABELS, line.status),
  ];

  const ruleRows = payload.rules.map((rule) => [
    rule.ruleCode,
    rule.title,
    formatCount(rule.total),
    formatCount(rule.dismissed),
    formatPermille(rule.dismissedPermille),
  ]);

  return createElement(
    Document,
    null,
    createElement(
      Page,
      { size: "A4", style: [styles.page, { fontFamily }] },
      createElement(Text, { style: styles.title }, AUDIT_REPORT_LABELS.title),
      metaLine(AUDIT_REPORT_LABELS.property, payload.property.name, "meta-property"),
      metaLine(
        AUDIT_REPORT_LABELS.period,
        `${payload.from} 〜 ${payload.to}`,
        "meta-period",
      ),
      metaLine(
        AUDIT_REPORT_LABELS.engine,
        `${payload.engineVersion} / ${payload.rulesetHash}`,
        "meta-engine",
      ),

      // 1. サマリー
      sectionTitle(AUDIT_REPORT_LABELS.section1, "s1"),
      summaryLine(AUDIT_REPORT_LABELS.roomDays, formatCount(payload.summary.roomDays), "s1-a"),
      summaryLine(
        AUDIT_REPORT_LABELS.sources,
        payload.summary.availableSources
          .map((source) => labelOf(AUDIT_REPORT_LABELS.sourceLabels, source))
          .join(" / "),
        "s1-b",
      ),
      summaryLine(AUDIT_REPORT_LABELS.total, formatCount(payload.summary.total), "s1-c"),
      summaryLine(labelOf(SEVERITY_LABELS, "HIGH"), formatCount(payload.summary.high), "s1-d", true),
      summaryLine(
        labelOf(SEVERITY_LABELS, "MEDIUM"),
        formatCount(payload.summary.medium),
        "s1-e",
        true,
      ),
      summaryLine(labelOf(SEVERITY_LABELS, "LOW"), formatCount(payload.summary.low), "s1-f", true),
      summaryLine(
        AUDIT_REPORT_LABELS.suppressed,
        formatCount(payload.summary.suppressed),
        "s1-g",
      ),
      summaryLine(AUDIT_REPORT_LABELS.resolved, formatCount(payload.summary.resolved), "s1-h"),
      summaryLine(AUDIT_REPORT_LABELS.dismissed, formatCount(payload.summary.dismissed), "s1-i"),
      summaryLine(AUDIT_REPORT_LABELS.open, formatCount(payload.summary.open), "s1-j"),

      // 2. 重要度別の推移（12 か月）
      sectionTitle(AUDIT_REPORT_LABELS.section2, "s2"),
      table(AUDIT_REPORT_LABELS.trendColumns, TREND_WIDTHS, trendRows, "trend"),

      // 3. 重要度 高 の全件詳細
      sectionTitle(AUDIT_REPORT_LABELS.section3, "s3"),
      table(
        AUDIT_REPORT_LABELS.findingColumns,
        FINDING_WIDTHS,
        payload.highFindings.map(findingRow),
        "high",
      ),

      // 4. 未対応項目一覧
      sectionTitle(AUDIT_REPORT_LABELS.section4, "s4"),
      table(
        AUDIT_REPORT_LABELS.findingColumns,
        FINDING_WIDTHS,
        payload.openFindings.map(findingRow),
        "open",
      ),

      // 5. ルール別の検出件数と対象外の割合
      sectionTitle(AUDIT_REPORT_LABELS.section5, "s5"),
      table(AUDIT_REPORT_LABELS.ruleColumns, RULE_WIDTHS, ruleRows, "rule"),

      // 6. 免責事項（§7.2 MUST）。**定数を直に読む。**
      sectionTitle(AUDIT_REPORT_LABELS.section6, "s6"),
      createElement(Text, { style: styles.disclaimer }, AUDIT_REPORT_DISCLAIMER),
    ),
  );
}
