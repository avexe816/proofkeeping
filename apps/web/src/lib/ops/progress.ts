/**
 * 進捗モニタ（施設横断）の組み立て。**純粋関数。**
 *
 * task:  docs/tasks/P7-19.md
 * 参照:  ui-prototypes/ops/pkops-A-daily-quality.html（03 進捗モニタ）
 * ルール: .claude/rules/architecture.md §3 / .claude/rules/ui-writing.md §2
 *
 * ── 集計元は rollup だけ ────────────────────────────────
 * 入力の `PropertySummary` は `getPropertySummaries()`（P0-21）の出力で、
 * あちらが §26 の「rollup 以外から取得しない」を守っている。
 * **ここでタスク表を数え直さない。** この関数は絞り込みと合計だけを行う。
 *
 * ── 個人単位の数字を持たない ────────────────────────────
 * 入力にも出力にも人の識別子が無い（CLAUDE.md §4 / P7-19「やらないこと」）。
 * 担当者別の列を足したくなったら、それはこの画面の仕事ではない。
 *
 * ── `hasRollup = false` を 0% と言わない ────────────────
 * rollup が無い施設は「集計がまだ無い」のであって「進捗 0」ではない
 * （`propertySummarySchema` の注記と同じ判断）。進捗率を `null` にし、
 * **全体の合計からも除く。** 混ぜると、集計前の施設が増えるほど
 * 全体の進捗率が実態より下がる。
 */

import type { PropertySummary } from "@pk/contracts";

import { formatPercent } from "../dashboard/format.js";
import type { ListScope } from "../property/listScope.js";

/** 施設ごとのリネン枚数（`sumLinenByProperty()` の値）。 */
export interface LinenSum {
  collectedQty: number;
  suppliedQty: number;
}

/** 1 施設ぶんの行。表示に使う値だけを持つ。 */
export interface ProgressRow {
  propertyId: string;
  name: string;
  roomCount: number;
  /** rollup が無ければ数字を出さない（`percent` も `null`）。 */
  hasRollup: boolean;
  totalTasks: number;
  completedTasks: number;
  reworkTasks: number;
  /** 「75.7%」。分母 0 か rollup 無しなら `null`。 */
  percent: string | null;
  /**
   * リネン枚数（回収 / 供給）。**記録が 1 件も無ければ `null`。**
   * 0 と表示すると「リネンを使っていない」と読める。記録していないのと
   * 使っていないのは違う（`hasRollup` と同じ判断）。
   */
  linen: LinenSum | null;
}

/** 全施設の合計。**rollup がある施設だけ**を足す。 */
export interface ProgressTotals {
  totalTasks: number;
  completedTasks: number;
  reworkTasks: number;
  percent: string | null;
  /** リネン枚数の合計。**記録がある施設だけ**を足す。 */
  linen: LinenSum;
  /** 集計がまだ無い施設の数。0 でなければ画面が注記を出す。 */
  pendingProperties: number;
}

export interface ProgressView {
  rows: readonly ProgressRow[];
  totals: ProgressTotals;
}

/**
 * サマリーを scope で絞り、行と合計に組み立てる。
 *
 * `summaries` は既にロールで絞られている（`listSelectableProperties()` /
 * 第 1 層）。ここで `scope.propertyIds` を重ねるのは、**画面の施設セレクタ
 * （1 施設に絞る操作）を反映するため**で、権限判定の代わりではない。
 * 権限は loader の `resolveListScope()` が先に済ませている。
 */
export function buildProgressView(
  summaries: readonly PropertySummary[],
  scope: ListScope,
  linenByProperty: ReadonlyMap<string, LinenSum> = new Map(),
): ProgressView {
  const allowed = scope.propertyIds === null ? null : new Set(scope.propertyIds);

  const rows: ProgressRow[] = summaries
    .filter((summary) => allowed === null || allowed.has(summary.propertyId))
    .map((summary) => ({
      propertyId: summary.propertyId,
      name: summary.name,
      roomCount: summary.roomCount,
      hasRollup: summary.hasRollup,
      totalTasks: summary.totalTasks,
      completedTasks: summary.completedTasks,
      reworkTasks: summary.reworkTasks,
      percent: summary.hasRollup
        ? formatPercent(summary.completedTasks, summary.totalTasks)
        : null,
      linen: linenByProperty.get(summary.propertyId) ?? null,
    }));

  const counted = rows.filter((row) => row.hasRollup);
  const totalTasks = counted.reduce((sum, row) => sum + row.totalTasks, 0);
  const completedTasks = counted.reduce((sum, row) => sum + row.completedTasks, 0);
  const reworkTasks = counted.reduce((sum, row) => sum + row.reworkTasks, 0);
  const linen = rows.reduce(
    (sum, row) =>
      row.linen === null
        ? sum
        : {
            collectedQty: sum.collectedQty + row.linen.collectedQty,
            suppliedQty: sum.suppliedQty + row.linen.suppliedQty,
          },
    { collectedQty: 0, suppliedQty: 0 },
  );

  return {
    rows,
    totals: {
      totalTasks,
      completedTasks,
      reworkTasks,
      percent: formatPercent(completedTasks, totalTasks),
      linen,
      pendingProperties: rows.length - counted.length,
    },
  };
}
