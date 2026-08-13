/**
 * 日報の集計（PK-SPEC-P2 §9.2）。**純粋関数。**
 *
 * task: docs/tasks/P2-14.md
 *
 * ── ここが「日報の中身」の唯一の出どころ ────────────────
 * §9.2 のサマリー・明細・未完了・不具合忘れ物を 1 つの payload にする。
 * **PDF もこの payload から描き、DB の集計列もこの payload から入れる。**
 * 完了条件の「PDF の集計値と DB 明細が一致する」は、**両者を突き合わせて
 * 確かめるのではなく、突き合わせる必要が無い形**で満たす。
 * 数え直す口を 2 つ作らないこと。
 *
 * ── サマリーは明細から数える ────────────────────────────
 * `summary` の各項目は、同じ関数に渡された明細の並びを数えた結果でしかない。
 * **引数でサマリーを受け取らない。** 呼び出し側が数えて渡す形にすると、
 * 「明細は 50 行あるのに完了 44 件」の日報が作れてしまう。
 *
 * ── 検査対象を「検査の記録があるタスク」と定義する ──────
 * §9.2 の例は 完了 50 = 検査対象 50、初回合格 44 + 差戻し 6 = 50。
 * `inspectionRequired` の設定ではなく**実際に検査が行われたかどうか**で
 * 数える。設定で数えると、抽出検査（§2.1 の `SAMPLE`）の施設で
 * 「検査対象 100 件・初回合格 12 件」のような読めない表になる。
 *
 * ── 時刻は ISO 8601 UTC の文字列で持つ ──────────────────
 * `isoUtc()`（§6.2 と同じ作り方）。**現地時刻への整形はここでしない。**
 * 施設のタイムゾーンを知っているのは表示側（`@pk/pdf`）で、
 * payload は「いつ」を曖昧さなく持つことだけを担う。整形をここへ入れると
 * ハッシュの対象に表示の都合が混ざる。
 */

import { isoUtc, type CanonicalValue } from "./evidence.js";

/** payload の版。**構造を変えたら上げること。** 過去の日報は旧版のまま残る。 */
export const DAILY_REPORT_SCHEMA_VERSION = "1";

// ────────────────────────────────────────────────────────────
// 入力（DB の行をそのまま渡さない。engine は @pk/db に依存しない）
// ────────────────────────────────────────────────────────────

/** 明細 1 行の元になるタスク。 */
export interface DailyReportTaskInput {
  taskId: string;
  roomNumber: string;
  /** 種別（`CHECKOUT` など）。**訳語は表示側が持つ。** */
  taskType: string;
  status: string;
  /** 担当者の表示名。未割当は `null`。 */
  assigneeName: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  /** 実作業分。`null` は「計測できていない」。0 と区別する。 */
  actualMinutes: number | null;
  /** 入室不可などの理由（`blockedReason`）。 */
  blockedReason: string | null;
}

/** タスクに紐づく検査。**ラウンドごとに 1 件。** */
export interface DailyReportInspectionInput {
  taskId: string;
  round: number;
  inspectorName: string | null;
  /** 未確定は `null`（検査中に日締めが来た場合）。 */
  result: string | null;
  selfApproved: boolean;
}

/** 差戻しサイクル。**件数だけを使う**（明細の「再清掃」列）。 */
export interface DailyReportReworkInput {
  taskId: string;
  round: number;
  status: string;
}

/** 不具合・忘れ物の 1 行（§9.2 の 4 列）。 */
export interface DailyReportFindingInput {
  /** 管理番号（忘れ物）または不具合の参照。 */
  reference: string;
  roomNumber: string;
  /** 区分（`VALUABLE` / `PLUMBING` など）。訳語は表示側。 */
  kind: string;
  status: string;
  /** `LOST_ITEM` か `ISSUE` か。表示側が節を分ける。 */
  source: "LOST_ITEM" | "ISSUE";
}

/** 日報 1 通ぶんの入力。 */
export interface DailyReportInput {
  documentNo: string;
  revision: number;
  businessDate: string;
  generatedAtMs: number;
  property: { code: string; name: string; timezone: string };
  tasks: readonly DailyReportTaskInput[];
  inspections: readonly DailyReportInspectionInput[];
  reworks: readonly DailyReportReworkInput[];
  findings: readonly DailyReportFindingInput[];
}

// ────────────────────────────────────────────────────────────
// 出力
// ────────────────────────────────────────────────────────────

/** §9.2 のサマリー。**すべて明細を数えた結果。** */
export interface DailyReportSummary {
  totalTasks: number;
  completedTasks: number;
  incompleteTasks: number;
  inspectedTasks: number;
  passedFirstRound: number;
  reworkedTasks: number;
  passedAfterRework: number;
  selfInspectedTasks: number;
}

/** 明細 1 行（§9.2 の「部屋 / 種別 / 担当 / 開始 / 完了 / 実作業分 / 検査者 / 結果 / 再清掃」）。 */
export interface DailyReportDetailRow {
  roomNumber: string;
  taskType: string;
  assigneeName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  actualMinutes: number | null;
  inspectorName: string | null;
  inspectionResult: string | null;
  reworkCount: number;
}

/** 未完了・入室不可の 1 行（§9.2 の「部屋 / 理由 / 現在状態 / 対応者」）。 */
export interface DailyReportIncompleteRow {
  roomNumber: string;
  reason: string | null;
  status: string;
  assigneeName: string | null;
}

/** 不具合・忘れ物の 1 行。 */
export interface DailyReportFindingRow {
  reference: string;
  roomNumber: string;
  kind: string;
  status: string;
  source: "LOST_ITEM" | "ISSUE";
}

/** 日報の payload。**PDF も DB の集計列もこれから作る。** */
export interface DailyReportPayload {
  schemaVersion: string;
  documentNo: string;
  revision: number;
  businessDate: string;
  generatedAt: string;
  property: { code: string; name: string; timezone: string };
  summary: DailyReportSummary;
  details: readonly DailyReportDetailRow[];
  incomplete: readonly DailyReportIncompleteRow[];
  findings: readonly DailyReportFindingRow[];
}

/** 完了とみなす状態。**`CANCELLED` は完了に数えない**（作業していない）。 */
const COMPLETED_STATUS = "COMPLETED";

/**
 * 客室番号の並び。**`302` の次は `1001`。**
 *
 * 文字列の比較だと `1001` が `302` より前に来る。現場の一覧は
 * 部屋番号順に読むので、数として比べる（`numeric: true`）。
 * 英字を含む番号（`A-12`）でも辞書順で安定して並ぶ。
 */
function byRoomNumber(a: { roomNumber: string }, b: { roomNumber: string }): number {
  return a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true });
}

/** タスク ID ごとに集める。 */
function groupByTaskId<T extends { taskId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.taskId);
    if (bucket === undefined) grouped.set(row.taskId, [row]);
    else bucket.push(row);
  }
  return grouped;
}

/** ラウンドの昇順で並べた検査。**入力の順序に依存しない。** */
function sortedRounds<T extends { round: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.round - b.round);
}

/**
 * 日報の payload を組む。
 *
 * @throws {RangeError} `generatedAtMs` が整数でないとき（`isoUtc()` 経由）。
 */
export function buildDailyReportPayload(input: DailyReportInput): DailyReportPayload {
  const inspectionsByTask = groupByTaskId(input.inspections);
  const reworksByTask = groupByTaskId(input.reworks);

  const tasks = [...input.tasks].sort(byRoomNumber);

  const details: DailyReportDetailRow[] = [];
  const incomplete: DailyReportIncompleteRow[] = [];

  let completedTasks = 0;
  let inspectedTasks = 0;
  let passedFirstRound = 0;
  let reworkedTasks = 0;
  let passedAfterRework = 0;
  let selfInspectedTasks = 0;

  for (const task of tasks) {
    const rounds = sortedRounds(inspectionsByTask.get(task.taskId) ?? []);
    const last = rounds.at(-1);
    const first = rounds.at(0);
    const reworkCount = (reworksByTask.get(task.taskId) ?? []).length;

    details.push({
      roomNumber: task.roomNumber,
      taskType: task.taskType,
      assigneeName: task.assigneeName,
      startedAt: task.startedAtMs === null ? null : isoUtc(task.startedAtMs),
      completedAt: task.completedAtMs === null ? null : isoUtc(task.completedAtMs),
      actualMinutes: task.actualMinutes,
      inspectorName: last?.inspectorName ?? null,
      inspectionResult: last?.result ?? null,
      reworkCount,
    });

    if (task.status === COMPLETED_STATUS) completedTasks += 1;
    else {
      incomplete.push({
        roomNumber: task.roomNumber,
        reason: task.blockedReason,
        status: task.status,
        assigneeName: task.assigneeName,
      });
    }

    // **検査の記録があるタスクだけを数える**（冒頭の注記）。
    if (rounds.length > 0) inspectedTasks += 1;
    if (first?.result === "PASS") passedFirstRound += 1;
    if (first?.result === "FAIL") {
      reworkedTasks += 1;
      // 初回で落ちた後、どこかのラウンドで合格したもの。
      if (rounds.slice(1).some((round) => round.result === "PASS")) passedAfterRework += 1;
    }
    if (rounds.some((round) => round.selfApproved)) selfInspectedTasks += 1;
  }

  const findings = [...input.findings].sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      byRoomNumber(a, b) ||
      a.reference.localeCompare(b.reference),
  );

  return {
    schemaVersion: DAILY_REPORT_SCHEMA_VERSION,
    documentNo: input.documentNo,
    revision: input.revision,
    businessDate: input.businessDate,
    generatedAt: isoUtc(input.generatedAtMs),
    property: { ...input.property },
    summary: {
      totalTasks: tasks.length,
      completedTasks,
      incompleteTasks: tasks.length - completedTasks,
      inspectedTasks,
      passedFirstRound,
      reworkedTasks,
      passedAfterRework,
      selfInspectedTasks,
    },
    details,
    incomplete,
    findings,
  };
}

/**
 * `canonicalJson()` へ渡せる形に落とす。
 *
 * **`DailyReportPayload` をそのまま渡せない。** `readonly` の配列は
 * `CanonicalValue` に代入できるが、`interface` は
 * インデックスシグネチャを持たないため型が合わない。ここで 1 度だけ
 * 変換する（値は写すだけで、内容を変えない）。
 */
export function dailyReportPayloadToCanonical(payload: DailyReportPayload): CanonicalValue {
  return {
    schemaVersion: payload.schemaVersion,
    documentNo: payload.documentNo,
    revision: payload.revision,
    businessDate: payload.businessDate,
    generatedAt: payload.generatedAt,
    property: { ...payload.property },
    summary: { ...payload.summary },
    details: payload.details.map((row) => ({ ...row })),
    incomplete: payload.incomplete.map((row) => ({ ...row })),
    findings: payload.findings.map((row) => ({ ...row })),
  };
}

/**
 * DB の `daily_report` へ入れる集計値（§9.4 の 5 列）。
 *
 * **payload から取り出すだけ。** 数え直さない。`openIssues` /
 * `openLostItems` は明細の並びから数える（不具合・忘れ物の節は
 * 「未解決のもの」だけを載せる / `lib/report/dailyReport.ts`）。
 */
export function dailyReportCounters(payload: DailyReportPayload): {
  totalTasks: number;
  completedTasks: number;
  failedFirstInspection: number;
  openIssues: number;
  openLostItems: number;
} {
  return {
    totalTasks: payload.summary.totalTasks,
    completedTasks: payload.summary.completedTasks,
    failedFirstInspection: payload.summary.reworkedTasks,
    openIssues: payload.findings.filter((row) => row.source === "ISSUE").length,
    openLostItems: payload.findings.filter((row) => row.source === "LOST_ITEM").length,
  };
}
