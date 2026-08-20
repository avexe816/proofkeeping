/**
 * ダッシュボード（本日の運用）の組み立て。**純粋関数。**
 *
 * 参照:  ui-prototypes/ops/pkops-A-daily-quality.html（01 ダッシュボード）
 * ルール: .claude/rules/architecture.md §3（集計は rollup）/
 *         .claude/rules/ui-writing.md §3（急かさない・個人を比べない）
 *
 * ── プロトタイプ 01 は「今日、手が足りているか」の画面 ──
 * 月次の全社サマリー（`lib/dashboard/org.ts` / PK-SPEC-P5 §7.1）とは
 * 別物で、見るのは**本日の業務日 1 日ぶん**（DECISIONS #216）。
 *
 * ── 施設別は「要確認の多い順」──────────────────────────
 * プロトタイプの確定事項。進捗率順にしないのは、**率が高くても要確認が
 * 残っている施設のほうが先に手当てが要る**ため。
 *
 * ── 集計がまだ無い施設を 0% と言わない ──────────────────
 * `hasRollup` が偽なら進捗率を `null` にし、**全体の合計からも除く**
 * （`lib/ops/progress.ts` と同じ判断）。混ぜると集計前の施設が増える
 * ほど全体の進捗が実態より低く出る。
 *
 * ── 個人の数字を持たない ────────────────────────────────
 * 入力にも出力にも人の識別子が無い（CLAUDE.md §4）。プロトタイプの
 * 「出勤」「担当」の列は出勤簿（P8-05）が無いため持たない。
 */

import type { PropertySummary } from "@pk/contracts";

import { formatPercent } from "./format.js";

/** 1 施設ぶんの行。 */
export interface DailyPropertyRow {
  propertyId: string;
  name: string;
  roomCount: number;
  /** 集計がまだ無い施設。数字を出さない。 */
  hasRollup: boolean;
  totalTasks: number;
  completedTasks: number;
  reworkTasks: number;
  /** 「75.7%」。分母 0 か集計無しなら `null`。 */
  percent: string | null;
  /** 進捗バーの幅（0〜100 の整数）。集計無しは `null`。 */
  percentValue: number | null;
  /** 要確認の件数（差異 HIGH ＋ 未対応の不具合）。並び替えの鍵。 */
  attention: number;
  openIssues: number;
  findingsHigh: number;
}

/** 全施設の合計。**集計のある施設だけ**を足す。 */
export interface DailyTotals {
  propertyCount: number;
  roomCount: number;
  totalTasks: number;
  completedTasks: number;
  reworkTasks: number;
  percent: string | null;
  percentValue: number | null;
  attention: number;
  openIssues: number;
  findingsHigh: number;
  /** 集計がまだ無い施設の数。0 でなければ画面が注記を出す。 */
  pendingProperties: number;
}

/** 直近 7 日の完了件数（棒グラフ 1 本）。 */
export interface DailyTrendPoint {
  businessDate: string;
  completedTasks: number;
  /** 棒の高さ（0〜100）。**期間内の最大を 100 とする相対値。** */
  heightPercent: number;
  /** 表示中の業務日か（プロトタイプの `hl`）。 */
  isCurrent: boolean;
}

export interface DailyDashboardView {
  rows: readonly DailyPropertyRow[];
  totals: DailyTotals;
  trend: readonly DailyTrendPoint[];
  /** 7 日平均（集計のある日だけの平均）。日が 1 つも無ければ `null`。 */
  trendAverage: number | null;
}

/** 進捗率を 0〜100 の整数で返す。分母 0 は `null`。 */
function percentValueOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.min(100, Math.round((numerator / denominator) * 100));
}

/**
 * 施設サマリー（rollup 由来）を本日の画面の形へ。
 *
 * @param summaries `getPropertySummaries()` の出力。ロールで絞り済み。
 * @param allowedPropertyIds 施設セレクタの絞り込み。`null` なら全施設。
 *   **権限判定の代わりではない**（loader の `resolveListScope()` が先）。
 */
export function buildDailyDashboard(
  summaries: readonly PropertySummary[],
  allowedPropertyIds: readonly string[] | null,
  /**
   * 施設 → 本日の重大な差異の件数（rollup の `findingsHigh`）。
   *
   * **`PropertySummary` には無い列**なので別に渡す。あちらは施設セレクタの
   * ミニバッジ用で、差異は載っていない（`lib/property/summary.ts`）。
   */
  findingsHighByProperty: ReadonlyMap<string, number>,
  trendInput: {
    /** 業務日 → その日の完了件数（scope 内の施設ぶんを合計済み）。 */
    completedByDate: ReadonlyMap<string, number>;
    /** 並べる業務日（古い順）。 */
    dates: readonly string[];
    /** 表示中の業務日。 */
    currentDate: string;
  },
): DailyDashboardView {
  const allowed = allowedPropertyIds === null ? null : new Set(allowedPropertyIds);

  const rows: DailyPropertyRow[] = summaries
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
      percentValue: summary.hasRollup
        ? percentValueOf(summary.completedTasks, summary.totalTasks)
        : null,
      attention: summary.openIssues + (findingsHighByProperty.get(summary.propertyId) ?? 0),
      openIssues: summary.openIssues,
      findingsHigh: findingsHighByProperty.get(summary.propertyId) ?? 0,
    }))
    // **要確認の多い順**（プロトタイプの確定事項）。同数なら未完了の多い順、
    // それも同じなら名前順（並びが実行のたびに変わらないように）。
    .sort(
      (a, b) =>
        b.attention - a.attention ||
        b.totalTasks - b.completedTasks - (a.totalTasks - a.completedTasks) ||
        a.name.localeCompare(b.name),
    );

  const counted = rows.filter((row) => row.hasRollup);
  const totalTasks = counted.reduce((sum, row) => sum + row.totalTasks, 0);
  const completedTasks = counted.reduce((sum, row) => sum + row.completedTasks, 0);

  const totals: DailyTotals = {
    propertyCount: rows.length,
    roomCount: rows.reduce((sum, row) => sum + row.roomCount, 0),
    totalTasks,
    completedTasks,
    reworkTasks: counted.reduce((sum, row) => sum + row.reworkTasks, 0),
    percent: formatPercent(completedTasks, totalTasks),
    percentValue: percentValueOf(completedTasks, totalTasks),
    attention: rows.reduce((sum, row) => sum + row.attention, 0),
    openIssues: rows.reduce((sum, row) => sum + row.openIssues, 0),
    findingsHigh: rows.reduce((sum, row) => sum + row.findingsHigh, 0),
    pendingProperties: rows.length - counted.length,
  };

  const values = trendInput.dates.map(
    (date) => trendInput.completedByDate.get(date) ?? 0,
  );
  const max = Math.max(...values, 0);
  const trend: DailyTrendPoint[] = trendInput.dates.map((date, index) => ({
    businessDate: date,
    completedTasks: values[index] ?? 0,
    // **最大を 100 とする相対値。** 絶対値で高さを決めると、規模の違う
    // 組織で棒が潰れる（プロトタイプも相対で描いている）。
    heightPercent: max === 0 ? 0 : Math.round(((values[index] ?? 0) / max) * 100),
    isCurrent: date === trendInput.currentDate,
  }));

  return {
    rows,
    totals,
    trend,
    trendAverage:
      values.length === 0
        ? null
        : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

/** 直近 N 日の業務日を古い順に並べる。**`YYYY-MM-DD` の文字計算**。 */
export function recentBusinessDates(businessDate: string, days: number): string[] {
  const base = new Date(`${businessDate}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(base.getTime() - offset * 24 * 60 * 60 * 1000);
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}
