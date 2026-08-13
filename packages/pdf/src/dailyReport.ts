/**
 * 日報 PDF のテンプレート（PK-SPEC-P2 §9.2）。
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/billing.md §2（電帳法）/ ui-writing.md §2（禁止語）
 *
 * ── JSX を使っていない ──────────────────────────────────
 * `React.createElement` を直に呼んでいる。理由は 2 つ。
 *   ① `.tsx` にすると ESLint の `pk/no-literal-string`（JSX 限定）が
 *      掛かる。あれは**画面**の文言を i18n へ寄せるための規則で、
 *      帳票の固定文言（`labels.ts`）はその対象ではない。
 *      規則を緩めるより、規則の外に置くほうが安全側。
 *   ② TypeScript の `.ts` だけを見ている tsconfig に、この 1 パッケージの
 *      ために `jsx` の設定と `.tsx` の include を増やさないため。
 * 表は「見出しの並び」と「行の並び」でしかないので、
 * 下の `row()` / `table()` で読める形になっている。
 *
 * ── 数値を再計算しない ──────────────────────────────────
 * 表示するのは `payload` の値そのまま。**ここで合計を取らない。**
 * 集計は `@pk/engine` の `buildDailyReportPayload()` だけが行う
 * （完了条件「PDF の集計値と DB 明細が一致する」）。
 *
 * ── 「文書ハッシュ」は payload のハッシュ ───────────────
 * §9.2 の最後の節。**PDF 自身の SHA-256 は PDF の中に書けない**
 * （書いた瞬間に値が変わる）。紙に載るのは payload のハッシュで、
 * PDF のハッシュは DB と R2 の metadata が持つ（§9.5）。
 */

import type { DailyReportPayload } from "@pk/engine";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";

import {
  DAILY_REPORT_LABELS,
  DETAIL_COLUMNS,
  FINDING_COLUMNS,
  INCOMPLETE_COLUMNS,
  INSPECTION_RESULT_LABELS,
  ISSUE_CATEGORY_LABELS,
  ISSUE_STATUS_LABELS,
  LOST_ITEM_CATEGORY_LABELS,
  LOST_ITEM_STATUS_LABELS,
  SUMMARY_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
  labelOf,
} from "./labels.js";
import {
  formatBusinessDate,
  formatClock,
  formatCount,
  formatDateTime,
  formatMinutes,
  formatReworkCount,
} from "./format.js";

/**
 * 使う書体。
 *
 * `EMBEDDED` は TTF を data URL で渡す。**日本語を出すにはこれが要る。**
 * 既定の Helvetica は CJK のグリフを持たず、和文が空白になる
 * （例外にはならない。だから「動いているのに読めない PDF」ができる）。
 *
 * `BUILT_IN_LATIN` は**テスト専用。** CI に和文フォントを置かずに
 * レイアウトの検査を回すためだけにある。コンシューマからは渡さない
 * （`apps/web/src/lib/report/font.ts` が実体を持ってくる）。
 */
export type DailyReportFont =
  | { kind: "EMBEDDED"; family: string; dataUrl: string }
  | { kind: "BUILT_IN_LATIN" };

/**
 * `renderToBuffer()` が受け取れる要素。
 *
 * `@react-pdf/renderer` は `DocumentProps` を**公開していない**ため、
 * 描画関数の引数から取り出す。`ReactElement` と書くと型引数が `unknown` に
 * なり、`renderToBuffer()` へ渡せない。
 */
export type DailyReportDocument = Parameters<
  typeof import("@react-pdf/renderer").renderToBuffer
>[0];

const styles = StyleSheet.create({
  page: { paddingTop: 32, paddingBottom: 32, paddingHorizontal: 32, fontSize: 9 },
  title: { fontSize: 16, marginBottom: 10 },
  metaRow: { flexDirection: "row", marginBottom: 2 },
  metaLabel: { width: 64 },
  notice: { marginTop: 6, marginBottom: 2 },
  sectionTitle: { fontSize: 12, marginTop: 14, marginBottom: 4 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#999999", paddingVertical: 3 },
  headerRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#333333", paddingVertical: 3 },
  cell: { paddingRight: 4 },
  summaryRow: { flexDirection: "row", paddingVertical: 2 },
  summaryLabel: { width: 96 },
  empty: { paddingVertical: 4 },
  hash: { marginTop: 12, fontSize: 8 },
});

/** 明細・未完了・不具合忘れ物の各列の幅（合計 100）。 */
const DETAIL_WIDTHS = [8, 10, 14, 9, 9, 10, 14, 10, 8] as const;
const INCOMPLETE_WIDTHS = [10, 45, 20, 25] as const;
const FINDING_WIDTHS = [22, 12, 30, 26] as const;

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

/** 見出し行 + 本文行。**0 行なら「該当なし」を出す**（節ごと消さない）。 */
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
      createElement(Text, null, DAILY_REPORT_LABELS.none),
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

function summaryLine(label: string, value: number, key: string): ReactElement {
  return createElement(
    View,
    { key, style: styles.summaryRow },
    createElement(Text, { style: styles.summaryLabel }, label),
    createElement(Text, null, formatCount(value)),
  );
}

/**
 * 日報の React 要素を組む。**描画（バイト列化）は `render.ts`。**
 *
 * @param payloadSha256 §9.2 の「文書ハッシュ」。payload のハッシュ（冒頭の注記）。
 */
export function buildDailyReportDocument(
  payload: DailyReportPayload,
  payloadSha256: string,
  font: DailyReportFont,
): DailyReportDocument {
  const timezone = payload.property.timezone;
  const fontFamily = font.kind === "EMBEDDED" ? font.family : "Helvetica";

  const details = payload.details.map((detail) => [
    detail.roomNumber,
    labelOf(TASK_TYPE_LABELS, detail.taskType),
    detail.assigneeName ?? "",
    formatClock(detail.startedAt, timezone),
    formatClock(detail.completedAt, timezone),
    formatMinutes(detail.actualMinutes),
    detail.inspectorName ?? "",
    labelOf(INSPECTION_RESULT_LABELS, detail.inspectionResult),
    formatReworkCount(detail.reworkCount),
  ]);

  const incomplete = payload.incomplete.map((task) => [
    task.roomNumber,
    task.reason ?? "",
    labelOf(TASK_STATUS_LABELS, task.status),
    task.assigneeName ?? "",
  ]);

  const findings = payload.findings.map((finding) => [
    finding.reference,
    finding.roomNumber,
    finding.source === "LOST_ITEM"
      ? labelOf(LOST_ITEM_CATEGORY_LABELS, finding.kind)
      : labelOf(ISSUE_CATEGORY_LABELS, finding.kind),
    finding.source === "LOST_ITEM"
      ? labelOf(LOST_ITEM_STATUS_LABELS, finding.status)
      : labelOf(ISSUE_STATUS_LABELS, finding.status),
  ]);

  const summary = payload.summary;

  return createElement(
    Document,
    { title: `${payload.documentNo} ${payload.businessDate}` },
    createElement(
      Page,
      { size: "A4", style: [styles.page, { fontFamily }] },
      createElement(Text, { style: styles.title }, DAILY_REPORT_LABELS.title),

      metaLine(DAILY_REPORT_LABELS.property, payload.property.name, "meta-property"),
      metaLine(
        DAILY_REPORT_LABELS.businessDate,
        formatBusinessDate(payload.businessDate),
        "meta-date",
      ),
      metaLine(
        DAILY_REPORT_LABELS.generatedAt,
        formatDateTime(payload.generatedAt, timezone),
        "meta-generated",
      ),
      metaLine(
        DAILY_REPORT_LABELS.documentNo,
        `${payload.documentNo}（${DAILY_REPORT_LABELS.revision} ${String(payload.revision)}）`,
        "meta-document",
      ),
      // 版が 2 以上のときだけ、旧版が残っていることを紙の上でも示す（§9.3）。
      payload.revision > 1
        ? createElement(
            View,
            { style: styles.notice },
            createElement(Text, null, DAILY_REPORT_LABELS.supersedes),
          )
        : null,

      createElement(Text, { style: styles.sectionTitle }, DAILY_REPORT_LABELS.summary),
      summaryLine(SUMMARY_LABELS.totalTasks, summary.totalTasks, "sum-total"),
      summaryLine(SUMMARY_LABELS.completedTasks, summary.completedTasks, "sum-completed"),
      summaryLine(SUMMARY_LABELS.incompleteTasks, summary.incompleteTasks, "sum-incomplete"),
      summaryLine(SUMMARY_LABELS.inspectedTasks, summary.inspectedTasks, "sum-inspected"),
      summaryLine(SUMMARY_LABELS.passedFirstRound, summary.passedFirstRound, "sum-first"),
      summaryLine(SUMMARY_LABELS.reworkedTasks, summary.reworkedTasks, "sum-rework"),
      summaryLine(SUMMARY_LABELS.passedAfterRework, summary.passedAfterRework, "sum-after"),
      summaryLine(SUMMARY_LABELS.selfInspectedTasks, summary.selfInspectedTasks, "sum-self"),

      createElement(Text, { style: styles.sectionTitle }, DAILY_REPORT_LABELS.details),
      table(DETAIL_COLUMNS, DETAIL_WIDTHS, details, "detail"),

      createElement(Text, { style: styles.sectionTitle }, DAILY_REPORT_LABELS.incomplete),
      table(INCOMPLETE_COLUMNS, INCOMPLETE_WIDTHS, incomplete, "incomplete"),

      createElement(Text, { style: styles.sectionTitle }, DAILY_REPORT_LABELS.findings),
      table(FINDING_COLUMNS, FINDING_WIDTHS, findings, "finding"),

      createElement(
        View,
        { style: styles.hash },
        createElement(Text, null, DAILY_REPORT_LABELS.documentHash),
        createElement(Text, null, `${DAILY_REPORT_LABELS.payloadSha256}: ${payloadSha256}`),
      ),
    ),
  );
}
