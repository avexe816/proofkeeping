/**
 * 施設選択画面の組み立て（PK-SPEC-P1 §19.4）。**純粋関数。**
 *
 * task: docs/tasks/P1-22.md
 * 参照: ui-prototypes/mobile/pk-03-property-picker.html（見た目の正）
 *
 * ── なぜこの画面が要るのか ──────────────────────────────
 * §19.3 のグループ表示は 3 施設までなら 1 画面に収まる。4 以上になると
 * スクロールが長くなり、**いまどの施設にいるのかが読めなくなる。**
 * そこで起動時に 1 回だけ「どこから始めるか」を選ばせる。
 *
 * ── 選択は絞り込みであって、権限ではない ────────────────
 * ここが返すのは**表示を絞るための候補**で、到達してよい施設の一覧では
 * ない。担当外の施設はそもそも `buildMyDay()` へ届かない（リポジトリ層の
 * `scopeToProperties()`）。選ばれた施設 ID をサーバー側の判定に使わないこと
 * （§19.8 / INV-32 — 施設は必ず資源から解決する）。
 *
 * ── 翌日は「表示のみ」──────────────────────────────────
 * §19.4 は「翌日以降のタスクは選択できるが、開始はできない（表示のみ）」。
 * プロトタイプは押せない形で描いているが、**仕様を採る**
 * （CLAUDE.md §7「仕様の唯一の正は仕様書。プロトタイプは見た目の正」/
 * docs/DECISIONS.md #042）。開始できないことは `startable` が表す。
 */

import type { MyDayGroup, MyDayTask } from "./myDay.js";
import { taskGroupOf } from "./taskBoard.js";

/** 選択画面の 1 行。 */
export interface PickerEntry<T extends MyDayTask> {
  propertyId: string;
  /** 施設名・コード。**清掃員の画面に出るのは名前だけ。** */
  property: MyDayGroup<T>["property"];
  businessDate: string;
  /** 当日ぶんか。`false` は「翌日以降（表示のみ）」。 */
  isToday: boolean;
  /** 開始できるか。**翌日以降は `false`**（§19.4）。 */
  startable: boolean;
  /** 「現在ここ」。当日の 1 件だけが `true` になりうる。 */
  isCurrent: boolean;
  taskCount: number;
  todoCount: number;
  reworkCount: number;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
}

/** 選択画面の上部に出す 3 項目（プロトタイプ 03 のサマリー）。 */
export interface PickerSummary {
  /** 当日の担当施設数。**閾値と比べるのはこの数**（§19.4）。 */
  propertyCount: number;
  /** 当日の総タスク数。 */
  totalTasks: number;
  /** 当日の再清掃件数。 */
  reworkTasks: number;
}

/** `buildPropertyPicker()` の結果。 */
export interface PropertyPicker<T extends MyDayTask> {
  summary: PickerSummary;
  entries: PickerEntry<T>[];
  /** 既定で選ばれる施設。当日のタスクが無ければ `null`。 */
  defaultPropertyId: string | null;
}

/**
 * 選択画面を挟むか（§19.4）。
 *
 * **比べるのは「当日の担当施設数」。** 割り当てられている施設の数ではない。
 * この画面が解こうとしているのは当日の一覧のスクロールの長さなので、
 * タスクの無い施設を数に入れると、画面に出ない施設のせいで選択画面が出る。
 * M-02 の「🏢 N施設を担当」と**同じ数**を使うこと（説明できる状態を保つ）。
 */
export function needsPropertyPicker(todayPropertyCount: number, threshold: number): boolean {
  return todayPropertyCount >= threshold;
}

/**
 * 当日と翌日のグループから選択画面を組み立てる。
 *
 * @param today 当日のグループ（`buildMyDay()` の出力）。並びは訪問順。
 * @param nextDay 翌日のグループ。**1 日ぶんだけ渡すこと**（プロトタイプ 03 Q3 —
 *   3 日先まで見せると情報量が増えるため翌日のみ）。
 * @param nowClock 現地の現在時刻 `HH:MM`。「現在ここ」の判定に使う。
 *   **`Date.now()` をここで呼ばない**（CLAUDE.md §5）。
 */
export function buildPropertyPicker<T extends MyDayTask>(
  today: {
    businessDate: string;
    groups: readonly MyDayGroup<T>[];
  },
  nextDay: {
    businessDate: string;
    groups: readonly MyDayGroup<T>[];
  },
  nowClock: string,
): PropertyPicker<T> {
  const todayEntries = today.groups.map((group) => toEntry(group, today.businessDate, true));
  const nextEntries = nextDay.groups.map((group) => toEntry(group, nextDay.businessDate, false));

  const currentPropertyId = resolveCurrentPropertyId(todayEntries, nowClock);
  for (const entry of todayEntries) {
    entry.isCurrent = entry.propertyId === currentPropertyId;
  }

  return {
    summary: {
      propertyCount: todayEntries.length,
      totalTasks: todayEntries.reduce((sum, entry) => sum + entry.taskCount, 0),
      reworkTasks: todayEntries.reduce((sum, entry) => sum + entry.reworkCount, 0),
    },
    entries: [...todayEntries, ...nextEntries],
    defaultPropertyId: currentPropertyId,
  };
}

function toEntry<T extends MyDayTask>(
  group: MyDayGroup<T>,
  businessDate: string,
  isToday: boolean,
): PickerEntry<T> {
  let todoCount = 0;
  let reworkCount = 0;
  for (const task of group.tasks) {
    const bucket = taskGroupOf(task.status);
    if (bucket === "TODO") todoCount += 1;
    if (bucket === "REWORK") reworkCount += 1;
  }
  return {
    propertyId: group.property.propertyId,
    property: group.property,
    businessDate,
    isToday,
    // §19.4「翌日以降のタスクは選択できるが、開始はできない」。
    startable: isToday,
    isCurrent: false,
    taskCount: group.taskCount,
    todoCount,
    reworkCount,
    plannedStartAt: group.plannedStartAt,
    plannedEndAt: group.plannedEndAt,
  };
}

/**
 * 「現在ここ」を決める（プロトタイプ 03 の推定ロジック）。
 *
 * ```
 * 1. 現在時刻が時間帯の中にある施設        → その施設
 * 2. どの時間帯にも当てはまらない          → 次に始まる施設
 * 3. 時間帯が 1 件も登録されていない        → 未着手が最も多い施設
 * ```
 *
 * **位置情報を使わない**（security.md §3・§4 の方針。GPS を扱わない）。
 * `dailyRoute` は P1 の間は常に空なので（docs/DECISIONS.md #037）、
 * 実際に効くのは 3 だけ。1・2 はシフトの入力経路（P8）ができた日に動く。
 */
function resolveCurrentPropertyId<T extends MyDayTask>(
  entries: readonly PickerEntry<T>[],
  nowClock: string,
): string | null {
  if (entries.length === 0) return null;

  // 1. 時間帯の中。**終了時刻が無い場合は「始まっていれば、いまそこ」**
  //    （開始時刻だけを入れた組織で 3 の判定へ落とさない）。
  for (const entry of entries) {
    if (entry.plannedStartAt === null) continue;
    if (entry.plannedStartAt > nowClock) continue;
    if (entry.plannedEndAt !== null && entry.plannedEndAt < nowClock) continue;
    return entry.propertyId;
  }

  // 2. 次に始まる施設。**過ぎた時間帯は候補にしない。**
  const upcoming = entries
    .filter((entry) => entry.plannedStartAt !== null && entry.plannedStartAt > nowClock)
    .sort((a, b) => ((a.plannedStartAt ?? "") < (b.plannedStartAt ?? "") ? -1 : 1));
  const next = upcoming[0];
  if (next !== undefined) return next.propertyId;

  // 3. 未着手が最も多い施設。**同数なら訪問順の先頭**（並びを覆さない）。
  let best = entries[0];
  if (best === undefined) return null;
  for (const entry of entries) {
    if (entry.todoCount > best.todoCount) best = entry;
  }
  return best.propertyId;
}
