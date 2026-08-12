/**
 * 人員配分（PK-SPEC-P1 §4.1・§4.3）。**純粋関数。**
 *
 * task: docs/tasks/P1-14.md
 *
 * ── 自動配分は提案でしかない ────────────────────────────
 * §4.1 MUST。**この関数は DB を書かない。** 画面がプレビューを出し、
 * 施設責任者が確定操作をしたあとで初めて `assignTasks()` が走る。
 * 「計算したのだから適用してよい」にしないための分割。
 *
 * ── 負荷は評価指標ではない ──────────────────────────────
 * §4.3 の「12件 / 480分 ⚠ 上限超過」は**当日の割り当てが偏っていないか**
 * を見るためのもので、個人の成績ではない（INV-01 / INV-03）。
 * 実績（完了までの実時間）をここで扱わないのは意図。入力は
 * `standardMinutes`（目安）だけで、`actualMinutes` を受け取らない。
 */

import { compareRoomNumber } from "./taskBoard.js";
import type { TaskStatusValue } from "./taskStatus.js";

/**
 * 1 人あたりの標準時間の上限（分）。§4.1 の「既定 420 分」。
 *
 * **設定項目にしない。** 上限を運用中に上げられるようにすると、
 * 「上限超過の警告が出るから上げる」が起きる（PK-IMPL-CONTRACT §11.4 の方針）。
 */
export const WORKLOAD_LIMIT_MINUTES = 420;

/** 配分の対象になるタスク。**担当者名を含めない**（INV-06 はここまで届く）。 */
export interface AssignableTask {
  taskId: string;
  roomNumber: string;
  /** 階の並び順。階が未登録なら `null`（数字の後ろへ回す）。 */
  floorOrder: number | null;
  priority: number;
  standardMinutes: number;
  status: TaskStatusValue;
  /** `membership.id`。未割当は `null`。 */
  assigneeId: string | null;
}

/** 配分先のスタッフ。**出勤しているかの判断は呼び出し側。** */
export interface AssignableStaff {
  membershipId: string;
  /** 並びを決めるためだけに使う。表示名ではない。 */
  staffNumber: string;
}

/** 1 人ぶんの負荷（§4.3）。 */
export interface WorkloadRow {
  membershipId: string;
  taskCount: number;
  minutes: number;
  /** 上限（420 分）を超えたか。**画面は警告を出す。** */
  overLimit: boolean;
}

/** 自動配分の提案（§4.1）。**適用は呼び出し側。** */
export interface AssignmentPlan {
  /** 割り当てる組み合わせ。**既に割当済みのタスクは含まない。** */
  assignments: readonly { taskId: string; membershipId: string }[];
  /** 適用後の負荷。既存の割当も足した値。 */
  loads: readonly WorkloadRow[];
  /** 割り当てきれなかったタスク（§4.1 の 5「`CREATED` のまま残す」）。 */
  unassignedTaskIds: readonly string[];
}

/**
 * 配分の対象になる状態か。
 *
 * §4.1 の 5 は「割り当てきれなかったタスクは `CREATED` のまま残す」。
 * つまり自動配分が触るのは**まだ着手していないタスクだけ。**
 * 作業中・完了・取消は動かさない（現場の手を止める）。
 */
export function isAssignable(status: TaskStatusValue): boolean {
  return status === "CREATED" || status === "ASSIGNED";
}

/**
 * 並び順（§4.1 の 1）。
 *
 * ```
 * priority 昇順 → floor 昇順 → room number 昇順
 * ```
 *
 * 階が未登録（`floorOrder === null`）の客室は最後へ回す。共用部のように
 * 階を持たない場所を先頭に置くと、動線が 1 階から始まらない。
 */
export function sortTasksForAssignment<T extends AssignableTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.floorOrder !== b.floorOrder) {
      if (a.floorOrder === null) return 1;
      if (b.floorOrder === null) return -1;
      return a.floorOrder - b.floorOrder;
    }
    return compareRoomNumber(a.roomNumber, b.roomNumber);
  });
}

/**
 * いまの負荷（§4.3）。**割当済みのタスクだけを数える。**
 *
 * 完了したタスクも数に入れる。当日の担当量を見る表であって、
 * 残りの作業量を見る表ではない（残量は客室ボードが持つ）。
 * **取消したタスクは数えない。** 予定から消えたものを負荷に載せない。
 */
export function summarizeWorkload(
  tasks: readonly AssignableTask[],
  staff: readonly AssignableStaff[],
  limitMinutes: number = WORKLOAD_LIMIT_MINUTES,
): WorkloadRow[] {
  const byStaff = new Map<string, { taskCount: number; minutes: number }>();
  for (const person of staff) byStaff.set(person.membershipId, { taskCount: 0, minutes: 0 });

  for (const task of tasks) {
    if (task.assigneeId === null) continue;
    if (task.status === "CANCELLED") continue;
    const row = byStaff.get(task.assigneeId);
    // 一覧に載っていないスタッフ（担当を外れた等）の割当も数える。
    // 数えないと「合計が合わない表」になり、割当漏れの調査ができない。
    if (row === undefined) {
      byStaff.set(task.assigneeId, { taskCount: 1, minutes: task.standardMinutes });
      continue;
    }
    row.taskCount += 1;
    row.minutes += task.standardMinutes;
  }

  return [...byStaff.entries()].map(([membershipId, row]) => ({
    membershipId,
    taskCount: row.taskCount,
    minutes: row.minutes,
    overLimit: row.minutes > limitMinutes,
  }));
}

/** 未割当のぶん（§4.3 の「未割当 3件 / 120分」）。 */
export function summarizeUnassigned(tasks: readonly AssignableTask[]): {
  taskCount: number;
  minutes: number;
} {
  const target = tasks.filter((task) => task.assigneeId === null && task.status !== "CANCELLED");
  return {
    taskCount: target.length,
    minutes: target.reduce((sum, task) => sum + task.standardMinutes, 0),
  };
}

/**
 * 自動配分の提案を作る（§4.1）。
 *
 * ```
 * 1. タスクを priority 昇順、次に floor → room number 昇順で並べる
 * 2. 出勤スタッフを担当フロアの希望順に並べる
 * 3. ラウンドロビンで割り当てる
 * 4. 1人あたりの合計標準時間が上限を超えたら次の人へ
 * 5. 割り当てきれなかったタスクは CREATED のまま残す
 * ```
 *
 * ── 2 の「担当フロアの希望順」を実装していない ──────────
 * **希望フロアを持つ列もテーブルも無い。** `property_assignment` は
 * 施設までしか持たず、階の希望はどこにも保存されていない。推測で
 * 並べると「なぜこの人が 3F なのか」を誰も説明できなくなるので、
 * **スタッフ番号の昇順**という説明可能な順で並べた。
 * docs/OPEN_QUESTIONS.md #039 に起票してある。
 *
 * ── 4 は「次の人へ」であって「打ち切り」ではない ────────
 * 上限に達した人を飛ばして次の人へ回す。全員が上限に達したら、
 * 残りは未割当のまま返す（5）。**上限を無視して詰め込まない。**
 *
 * @param tasks その業務日・その施設のタスク全件（割当済みを含む）。
 * @param staff 出勤スタッフ。空なら全件が未割当。
 */
export function planAutoAssignment(
  tasks: readonly AssignableTask[],
  staff: readonly AssignableStaff[],
  limitMinutes: number = WORKLOAD_LIMIT_MINUTES,
): AssignmentPlan {
  // 既存の割当を含めた負荷から始める。**空の状態から配り直さない。**
  // 途中まで手で配ったところへ自動配分を掛けても、手の配分が消えない。
  const order = [...staff].sort((a, b) =>
    a.staffNumber < b.staffNumber ? -1 : a.staffNumber > b.staffNumber ? 1 : 0,
  );
  const minutes = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const person of order) {
    minutes.set(person.membershipId, 0);
    counts.set(person.membershipId, 0);
  }
  for (const task of tasks) {
    if (task.assigneeId === null || task.status === "CANCELLED") continue;
    if (!minutes.has(task.assigneeId)) continue;
    minutes.set(task.assigneeId, (minutes.get(task.assigneeId) ?? 0) + task.standardMinutes);
    counts.set(task.assigneeId, (counts.get(task.assigneeId) ?? 0) + 1);
  }

  const targets = sortTasksForAssignment(
    tasks.filter((task) => task.assigneeId === null && isAssignable(task.status)),
  );

  const assignments: { taskId: string; membershipId: string }[] = [];
  const unassignedTaskIds: string[] = [];
  let cursor = 0;

  for (const task of targets) {
    let picked: string | null = null;
    // ラウンドロビン。上限に達した人は飛ばす。全員が上限なら未割当。
    for (let step = 0; step < order.length; step += 1) {
      const person = order[(cursor + step) % order.length];
      if (person === undefined) continue;
      const current = minutes.get(person.membershipId) ?? 0;
      if (current + task.standardMinutes > limitMinutes) continue;
      picked = person.membershipId;
      cursor = (cursor + step + 1) % order.length;
      break;
    }

    if (picked === null) {
      unassignedTaskIds.push(task.taskId);
      continue;
    }
    assignments.push({ taskId: task.taskId, membershipId: picked });
    minutes.set(picked, (minutes.get(picked) ?? 0) + task.standardMinutes);
    counts.set(picked, (counts.get(picked) ?? 0) + 1);
  }

  return {
    assignments,
    loads: order.map((person) => ({
      membershipId: person.membershipId,
      taskCount: counts.get(person.membershipId) ?? 0,
      minutes: minutes.get(person.membershipId) ?? 0,
      overLimit: (minutes.get(person.membershipId) ?? 0) > limitMinutes,
    })),
    unassignedTaskIds,
  };
}
