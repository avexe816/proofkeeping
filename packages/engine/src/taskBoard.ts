/**
 * M-02 / M-03 の並び順と経過時間の色分け（PK-SPEC-P1 §9.2・§9.3）。**純粋関数。**
 *
 * task: docs/tasks/P1-08.md / docs/tasks/P1-09.md
 *
 * ── なぜ画面ではなくここに置くのか ──────────────────────
 * 並び順は「現場が次に何をするか」を決める規則で、見た目ではない。
 * 画面のコンポーネントの中に `sort()` を書くと、規則が正しいことを
 * ブラウザ無しに確かめられなくなる（テスト環境は node / testing.md）。
 * 経過時間の色も同じ。**INV-05（赤を使わない）はここで閉じる。**
 */

import type { TaskStatusValue } from "./taskStatus.js";

/**
 * M-02 の 5 段カウンタ（`ui-prototypes/mobile/pk-02-today-tasks.html`）。
 *
 * 清掃員から見た区分であって、状態そのものではない。
 * **`AWAITING_INSPECTION` は「完了」に入れる。** 自分の作業は終わっており、
 * 検査は別の人の仕事（プロトタイプの注記と同じ）。
 */
export const TASK_GROUPS = ["TODO", "IN_PROGRESS", "REWORK", "BLOCKED", "DONE"] as const;

export type TaskGroup = (typeof TASK_GROUPS)[number];

/** 状態 → 区分。`CANCELLED` はどの段にも入れない（画面に出さない）。 */
export function taskGroupOf(status: TaskStatusValue): TaskGroup | null {
  switch (status) {
    case "CREATED":
    case "ASSIGNED":
      return "TODO";
    case "IN_PROGRESS":
    case "PAUSED":
      return "IN_PROGRESS";
    case "REWORK":
      return "REWORK";
    case "BLOCKED":
      return "BLOCKED";
    case "AWAITING_INSPECTION":
    case "COMPLETED":
      return "DONE";
    case "CANCELLED":
      return null;
  }
}

/**
 * 並び順の重み（§9.2 の「作業中 → 差戻し → 未着手 → 入室不可 → 完了」）。
 *
 * **プロトタイプ（pk-02）は「再清掃 → 作業中」の順で描いており、仕様と
 * 食い違う。** 並び順は見た目ではなく動きなので、仕様書（§9.2 要件の
 * 1 行目）を採った。差分は docs/OPEN_QUESTIONS.md #035 に起票してある。
 * 差戻し（`REWORK`）は P2 の検査フローが作る状態で、P1 では現れない。
 */
const GROUP_ORDER: Readonly<Record<TaskGroup, number>> = {
  IN_PROGRESS: 0,
  REWORK: 1,
  TODO: 2,
  BLOCKED: 3,
  DONE: 4,
};

/** 並べ替えに要る最小限の形。`TaskSummary` の部分集合。 */
export interface SortableTask {
  status: TaskStatusValue;
  priority: number;
  roomNumber: string;
}

/**
 * 客室番号の比較。**文字列としてではなく、数字は数値として比べる。**
 *
 * 並び順を持つのは M-02 だけではない（W-04 の配分・W-03 の客室ボードも
 * 同じ順で並べる）。**同じ比較を各所で書き直さないこと。**
 *
 * `"302"` と `"1002"` を辞書順で並べると 1002 が先に来る。現場の動線は
 * フロア順なので、数字の桁を跨ぐ施設で並びが崩れる。数字で始まらない
 * 番号（`"LOBBY"` のような共用部）は数字の後ろへ回す。
 */
export function compareRoomNumber(a: string, b: string): number {
  const numA = /^\d+/.exec(a)?.[0];
  const numB = /^\d+/.exec(b)?.[0];
  if (numA !== undefined && numB !== undefined && numA !== numB) {
    return Number(numA) - Number(numB);
  }
  if (numA !== undefined && numB === undefined) return -1;
  if (numA === undefined && numB !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * M-02 の並び順（§9.2）。
 *
 * ```
 * 作業中 → 差戻し → 未着手（priority 昇順）→ 入室不可 → 完了
 * ```
 *
 * 同じ段の中は `priority` 昇順、次に客室番号。**`CANCELLED` は落とす。**
 * 取消されたタスクを現場の一覧に出しても、押せる操作が無い。
 *
 * 入力を書き換えない（`[...tasks]` を並べ替える）。
 */
export function sortTasksForBoard<T extends SortableTask>(tasks: readonly T[]): T[] {
  return [...tasks]
    .filter((task) => taskGroupOf(task.status) !== null)
    .sort((a, b) => {
      const groupA = taskGroupOf(a.status);
      const groupB = taskGroupOf(b.status);
      // filter 済みなので null は来ない。型を絞るためだけの分岐。
      if (groupA === null || groupB === null) return 0;
      if (groupA !== groupB) return GROUP_ORDER[groupA] - GROUP_ORDER[groupB];
      if (a.priority !== b.priority) return a.priority - b.priority;
      return compareRoomNumber(a.roomNumber, b.roomNumber);
    });
}

/** 5 段カウンタの集計。**表示しない段も 0 で返す**（欠けると桁が動く）。 */
export function countByGroup(
  tasks: readonly { status: TaskStatusValue }[],
): Record<TaskGroup, number> {
  const counts: Record<TaskGroup, number> = {
    TODO: 0,
    IN_PROGRESS: 0,
    REWORK: 0,
    BLOCKED: 0,
    DONE: 0,
  };
  for (const task of tasks) {
    const group = taskGroupOf(task.status);
    if (group !== null) counts[group] += 1;
  }
  return counts;
}

/**
 * 経過時間の色（§9.3 / INV-05）。
 *
 * ```
 * 目安以内        NORMAL
 * 目安を超えた    OVER      … オレンジ
 * 目安の 1.5 倍   FAR_OVER  … グレー
 * ```
 *
 * **`DANGER` に相当する値を返さない。** 赤は失敗を意味し、丁寧に作業する
 * 者を追い詰める（INV-05）。この関数に赤を足す変更を通さないこと。
 */
export const ELAPSED_TONES = ["NORMAL", "OVER", "FAR_OVER"] as const;

export type ElapsedTone = (typeof ELAPSED_TONES)[number];

/** グレーへ落とす倍率（§9.3）。 */
export const FAR_OVER_RATIO = 1.5;

/**
 * 経過時間の色を決める。
 *
 * @param standardMinutes 目安時間（分）。0 以下なら常に `NORMAL`
 *   （目安の無いタスクを「超過」と見せない）。
 * @param elapsedMs 経過（ミリ秒）。
 */
export function elapsedToneOf(standardMinutes: number, elapsedMs: number): ElapsedTone {
  if (standardMinutes <= 0) return "NORMAL";
  const standardMs = standardMinutes * 60_000;
  if (elapsedMs >= standardMs * FAR_OVER_RATIO) return "FAR_OVER";
  if (elapsedMs > standardMs) return "OVER";
  return "NORMAL";
}

/**
 * 残り時間（分）。**負の値を返さない。**
 *
 * 超過している間は 0 を返す。「残り −12 分」を現場に見せない
 * （急かす表現を避ける / §9.3）。
 */
export function remainingMinutes(standardMinutes: number, elapsedMs: number): number {
  const remainingMs = standardMinutes * 60_000 - elapsedMs;
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 60_000);
}
