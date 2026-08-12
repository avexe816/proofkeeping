/**
 * 1 日の動線（PK-SPEC-P1 §19.3・§19.5・§19.6）。**純粋関数。**
 *
 * task: docs/tasks/P1-21.md
 *
 * ── 「施設を切り替える」概念を持ち込まない（§19.2 MUST）─
 * ここが返すのは**施設ごとにグループ化された 1 本のリスト**であって、
 * 「いま選ばれている施設」ではない。選択の状態を持たせると、切替を忘れて
 * 別施設のタスクを開始する誤操作の余地ができる。
 * 4 施設以上のときに挟む選択画面（§19.4 / P1-22）は**表示を絞る**だけで、
 * この関数の出力の形は変わらない。
 *
 * ── `dailyRoute` が無くても動く（§19.5 MUST）───────────
 * 訪問順の登録が 1 件も無い担当者は、**施設名の昇順**でグループ化し、
 * 移動ブロックを出さない。シフトを入力していない組織で一覧が空になる、
 * という壊れ方をさせない。
 */

import { sortTasksForBoard, taskGroupOf, type SortableTask } from "./taskBoard.js";
import type { TaskStatusValue } from "./taskStatus.js";

/** グループ化するタスク。`SortableTask` に施設を足しただけ。 */
export interface MyDayTask extends SortableTask {
  taskId: string;
  propertyId: string;
}

/** 施設の最小限の情報。**清掃員の画面に出るのは名前だけ。** */
export interface MyDayProperty {
  propertyId: string;
  code: string;
  name: string;
}

/** `dailyRoute` の 1 行のうち、並びに使う項目。 */
export interface RouteLeg {
  sequence: number;
  propertyId: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  /** **次の**施設への移動時間（分）。未設定なら `null`。 */
  travelMinutes: number | null;
}

/** 施設 1 つぶんのまとまり（§19.6 の `groups[]`）。 */
export interface MyDayGroup<T extends MyDayTask> {
  /** 訪問順 1, 2, 3...。`dailyRoute` が無ければ施設名昇順の連番。 */
  sequence: number;
  property: MyDayProperty;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  /** 次の施設への移動時間（分）。最後の施設・未設定なら `null`。 */
  travelMinutesToNext: number | null;
  taskCount: number;
  tasks: T[];
  /**
   * 全タスクが完了（§19.3 の「完了した施設は自動で折りたたむ」）。
   *
   * **画面の開閉状態ではなく、初期状態の判断材料。** 利用者が開いたあとに
   * 勝手に閉じない責任は画面側にある。
   */
  allDone: boolean;
}

/** 5 段カウンタ（§19.6 の `summary`）。 */
export interface MyDaySummary {
  todo: number;
  inProgress: number;
  rework: number;
  blocked: number;
  done: number;
}

/** `buildMyDay()` の結果（§19.6 の `data`）。 */
export interface MyDay<T extends MyDayTask> {
  propertyCount: number;
  totalTasks: number;
  summary: MyDaySummary;
  groups: MyDayGroup<T>[];
}

/** 一覧のフィルタ（§19.3 の「すべて / 未着手 / 完了」）。 */
export const MY_DAY_FILTERS = ["ALL", "TODO", "DONE"] as const;

export type MyDayFilter = (typeof MY_DAY_FILTERS)[number];

/**
 * 1 日ぶんをグループへ組み立てる。
 *
 * @param tasks 担当者本人のタスク。**他人のタスクを渡さない**（INV-07）。
 * @param properties 施設。`tasks` に出てくる施設が欠けていた場合、その
 *   グループは落とす。**施設名を出せないグループを描かない**（§19.8 の
 *   「部屋番号だけを表示しない」と同じ理由）。
 * @param route `dailyRoute` の行。空配列でよい（§19.5 MUST）。
 */
export function buildMyDay<T extends MyDayTask>(
  tasks: readonly T[],
  properties: readonly MyDayProperty[],
  route: readonly RouteLeg[],
): MyDay<T> {
  const propertyById = new Map(properties.map((property) => [property.propertyId, property]));

  const byProperty = new Map<string, T[]>();
  for (const task of tasks) {
    // 取消済みは現場の一覧に出さない（`sortTasksForBoard()` と同じ判断）。
    if (taskGroupOf(task.status) === null) continue;
    const bucket = byProperty.get(task.propertyId);
    if (bucket === undefined) byProperty.set(task.propertyId, [task]);
    else bucket.push(task);
  }

  const groups: MyDayGroup<T>[] = [];
  for (const propertyId of orderPropertyIds([...byProperty.keys()], properties, route)) {
    const property = propertyById.get(propertyId);
    if (property === undefined) continue;
    const bucket = byProperty.get(propertyId) ?? [];
    const sorted = sortTasksForBoard(bucket);
    const leg = route.find((entry) => entry.propertyId === propertyId);
    groups.push({
      // 訪問順は**この一覧の中での連番**にする。`dailyRoute.sequence` を
      // そのまま出すと、タスクの無い施設を飛ばしたぶん番号が抜ける。
      sequence: groups.length + 1,
      property,
      plannedStartAt: leg?.plannedStartAt ?? null,
      plannedEndAt: leg?.plannedEndAt ?? null,
      travelMinutesToNext: null,
      taskCount: sorted.length,
      tasks: sorted,
      allDone: sorted.every((task) => taskGroupOf(task.status) === "DONE"),
    });
  }

  // 移動時間は**次のグループがあるときだけ**載せる。最後の施設に
  // 「移動 25 分」が出ると、帰り道の指示に読める。
  for (const [index, group] of groups.entries()) {
    if (index === groups.length - 1) continue;
    const leg = route.find((entry) => entry.propertyId === group.property.propertyId);
    group.travelMinutesToNext = leg?.travelMinutes ?? null;
  }

  return {
    propertyCount: groups.length,
    totalTasks: groups.reduce((sum, group) => sum + group.taskCount, 0),
    summary: summarize(groups.flatMap((group) => group.tasks)),
    groups,
  };
}

/**
 * 施設の並び。**`dailyRoute` にある施設が先、無い施設は名前の昇順で後ろ。**
 *
 * 部分的にしか登録されていない日（1 施設だけ順番が入っている）を
 * 「未登録」と同じ扱いに落とさない。入っているぶんは指示として尊重する。
 */
function orderPropertyIds(
  propertyIds: readonly string[],
  properties: readonly MyDayProperty[],
  route: readonly RouteLeg[],
): string[] {
  const nameById = new Map(properties.map((property) => [property.propertyId, property.name]));
  const sequenceById = new Map(route.map((leg) => [leg.propertyId, leg.sequence]));

  return [...propertyIds].sort((a, b) => {
    const seqA = sequenceById.get(a);
    const seqB = sequenceById.get(b);
    if (seqA !== undefined && seqB !== undefined) return seqA - seqB;
    if (seqA !== undefined) return -1;
    if (seqB !== undefined) return 1;
    const nameA = nameById.get(a) ?? "";
    const nameB = nameById.get(b) ?? "";
    return nameA < nameB ? -1 : nameA > nameB ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** 5 段カウンタ。**表示しない段も 0 で返す**（欠けると桁が動く）。 */
function summarize(tasks: readonly { status: TaskStatusValue }[]): MyDaySummary {
  const summary: MyDaySummary = { todo: 0, inProgress: 0, rework: 0, blocked: 0, done: 0 };
  for (const task of tasks) {
    switch (taskGroupOf(task.status)) {
      case "TODO":
        summary.todo += 1;
        break;
      case "IN_PROGRESS":
        summary.inProgress += 1;
        break;
      case "REWORK":
        summary.rework += 1;
        break;
      case "BLOCKED":
        summary.blocked += 1;
        break;
      case "DONE":
        summary.done += 1;
        break;
      case null:
        break;
    }
  }
  return summary;
}

/**
 * フィルタを**全施設をまたいで**適用する（§19.3 MUST）。
 *
 * 施設ごとに絞ると「この施設は 0 件」というグループが残り、
 * 何が絞られたのかが読めなくなる。**空になったグループは落とす。**
 * カウンタ（`summary`）は絞る前の値のまま返す。フィルタのボタンに出る
 * 件数が、押した結果で変わってしまうため。
 */
export function filterMyDay<T extends MyDayTask>(day: MyDay<T>, filter: MyDayFilter): MyDay<T> {
  if (filter === "ALL") return day;

  const keep = (status: TaskStatusValue): boolean => {
    const group = taskGroupOf(status);
    // 「未着手」は未着手だけ。作業中・差戻し・入室不可を混ぜない
    // （§19.3 のボタンは 3 つで、混ぜると押した結果が説明できない）。
    return filter === "TODO" ? group === "TODO" : group === "DONE";
  };

  const kept = day.groups
    .map((group) => {
      const tasks = group.tasks.filter((task) => keep(task.status));
      return { ...group, tasks, taskCount: tasks.length };
    })
    .filter((group) => group.tasks.length > 0);

  const groups = kept.map((group, index) => ({
    ...group,
    sequence: index + 1,
    // 絞った結果として最後になったグループの移動時間を落とす。
    // 残さないと、次の行き先が消えているのに「移動 25 分」だけが残る。
    travelMinutesToNext: index === kept.length - 1 ? null : group.travelMinutesToNext,
  }));

  return {
    ...day,
    groups,
    // **絞ったあとの実数**を出す。ヘッダの「N件」は見えている件数と合わせる。
    totalTasks: groups.reduce((sum, group) => sum + group.taskCount, 0),
    propertyCount: groups.length,
  };
}
