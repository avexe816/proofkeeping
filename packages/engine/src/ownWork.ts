/**
 * M-11「自分の実績」の集計（PK-SPEC-P1 §9.6）。**純粋関数。**
 *
 * task:  docs/tasks/P1-17.md
 * ルール: .claude/rules/security.md §5（従業員データ）
 *
 * ── 他人が入り込む余地を型で塞ぐ ────────────────────────
 * 入力は**1 人ぶんのタスク**しか受け取らない。担当者 ID の配列も、
 * 比較対象も引数に無い。ランキングを作ろうとすると、まず関数の形を
 * 変えることになる（INV-02 / §9.6 MUST）。
 *
 * ── 平均だけが「指標」──────────────────────────────────
 * 完了件数・作業中の件数・合計作業時間は**起きた事実**で、記録そのもの。
 * 一方「1 室あたり平均 26 分」は事実から作った**指標**で、少ない母数では
 * 意味を持たない。security.md §5 は「個人単位の指標は対象期間 20 タスク
 * 未満なら表示しない」と定めるので、**平均だけを閾値で伏せる。**
 * 件数と合計時間まで伏せると、本人が自分の記録を見る画面（同 §5 MUST）が
 * 成り立たなくなる。判断の経緯は docs/DECISIONS.md #035。
 */

import type { TaskStatusValue } from "./taskStatus.js";

/**
 * 平均を出すのに要る最低タスク数（security.md §5）。
 *
 * **設定項目にしない**（PK-IMPL-CONTRACT §11.4 の方針）。
 */
export const MINIMUM_TASKS_FOR_AVERAGE = 20;

/** 集計に要る 1 件ぶん。**客室番号も担当者 ID も要らない。** */
export interface OwnWorkTask {
  status: TaskStatusValue;
  /** 実作業時間（分）。中断を含まない。未完了は `null`。 */
  actualMinutes: number | null;
}

/** M-11 に出す値。 */
export interface OwnWorkSummary {
  /** 完了した件数。**検査待ちも「自分の作業としては終わり」なので含む。** */
  completed: number;
  /** 作業中（中断中を含む）の件数。 */
  inProgress: number;
  /** 合計作業時間（分）。完了したタスクの実作業時間の合計。 */
  workedMinutes: number;
  /**
   * 1 室あたりの平均（分）。**母数が `MINIMUM_TASKS_FOR_AVERAGE` 未満なら
   * `null`。** 画面は `null` のとき数字ではなく理由を示す。
   */
  averageMinutes: number | null;
}

/** 自分のタスクをまとめる。**入力を書き換えない。** */
export function summarizeOwnWork(tasks: readonly OwnWorkTask[]): OwnWorkSummary {
  const completedTasks = tasks.filter(
    (task) => task.status === "COMPLETED" || task.status === "AWAITING_INSPECTION",
  );
  const inProgress = tasks.filter(
    (task) => task.status === "IN_PROGRESS" || task.status === "PAUSED",
  ).length;

  const workedMinutes = completedTasks.reduce((sum, task) => sum + (task.actualMinutes ?? 0), 0);

  // 実作業時間の記録がある完了タスクだけを母数にする。時間ログの無い
  // タスク（移行データ等）を 0 分として混ぜると平均が実態より短くなる。
  const measured = completedTasks.filter((task) => task.actualMinutes !== null);

  return {
    completed: completedTasks.length,
    inProgress,
    workedMinutes,
    averageMinutes:
      measured.length < MINIMUM_TASKS_FOR_AVERAGE
        ? null
        : Math.round(
            measured.reduce((sum, task) => sum + (task.actualMinutes ?? 0), 0) / measured.length,
          ),
  };
}

/**
 * 業務日の週の範囲（月曜はじまり）を返す。
 *
 * §9.6 の「今週」。業務日は `YYYY-MM-DD` の文字列で、日付の計算は
 * **UTC の正午**を基準に行う（`new Date("2026-08-10")` は UTC 深夜に
 * なるため、タイムゾーンによっては前日へずれる）。
 *
 * 時刻を引数から作るのでこの関数も純粋（`Date.now()` を呼ばない）。
 */
export function weekRangeOf(businessDate: string): { from: string; to: string } {
  const base = new Date(`${businessDate}T12:00:00.000Z`);
  // getUTCDay(): 0 = 日曜。月曜を週のはじまりにするため 0 を 7 として扱う。
  const weekday = base.getUTCDay() === 0 ? 7 : base.getUTCDay();
  const monday = new Date(base.getTime() - (weekday - 1) * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { from: toBusinessDate(monday), to: toBusinessDate(sunday) };
}

/**
 * 業務日の属する月の範囲を返す（§19.9 の「施設別（今月）」）。
 *
 * `weekRangeOf()` と同じく **UTC の正午**を基準に組み立てる。
 */
export function monthRangeOf(businessDate: string): { from: string; to: string } {
  const base = new Date(`${businessDate}T12:00:00.000Z`);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1, 12));
  // 翌月 0 日 ＝ 当月末日。月ごとの日数を持たない。
  const last = new Date(Date.UTC(year, month + 1, 0, 12));
  return { from: toBusinessDate(first), to: toBusinessDate(last) };
}

/** 施設別の集計に渡す 1 件。**担当者 ID も客室も要らない。** */
export interface OwnWorkByPropertyTask {
  propertyId: string;
  status: TaskStatusValue;
}

/** 施設 1 つぶんの内訳（§19.9）。 */
export interface OwnWorkPropertyRow {
  propertyId: string;
  /** 完了した件数。**検査待ちも含む**（`summarizeOwnWork()` と同じ扱い）。 */
  completed: number;
}

/**
 * 施設別の完了件数（PK-SPEC-P1 §19.9）。**自分のぶんだけ。**
 *
 * ── 出すのは件数だけ ────────────────────────────────────
 * 平均も所要時間も返さない。§19.9 が求めるのは「どの施設で何件やったか」で、
 * それは**事実**（docs/DECISIONS.md #035 の区別）。施設ごとの平均を出すと、
 * 母数の小さい施設で意味の無い数字が並び、しかも施設間の比較に読める。
 *
 * **他人の行が混ざらないのは呼び出し側の責任**（`listTasks({ assigneeId: 自分 })`）。
 * この関数は担当者 ID を受け取らないので、比較表を作るには形を変えるしかない
 * （§9.6 MUST / INV-02 — `summarizeOwnWork()` と同じ設計）。
 *
 * @returns 完了件数の降順。同数なら `propertyId` の昇順（並びを安定させる）。
 *   **0 件の施設は返さない。**
 */
export function summarizeOwnWorkByProperty(
  tasks: readonly OwnWorkByPropertyTask[],
): OwnWorkPropertyRow[] {
  const completedByProperty = new Map<string, number>();
  for (const task of tasks) {
    if (task.status !== "COMPLETED" && task.status !== "AWAITING_INSPECTION") continue;
    completedByProperty.set(task.propertyId, (completedByProperty.get(task.propertyId) ?? 0) + 1);
  }
  return [...completedByProperty.entries()]
    .map(([propertyId, completed]) => ({ propertyId, completed }))
    .sort((a, b) => b.completed - a.completed || (a.propertyId < b.propertyId ? -1 : 1));
}

function toBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
