/**
 * 月次レポートの組み立て（owner 09）。
 *
 * 台帳:  docs/PROTOTYPE_GAP.md 第2批 09 / DECISIONS #196
 * 参照:  ui-prototypes/owner/pkown-v3-C-inspection-linen-report.html（09）
 *
 * ── 計算はここでしない ──────────────────────────────────
 * 率・中央値・前月比は `packages/engine` の `computeMonthlyReport()`。
 * この層の仕事は**読み取りと写像だけ**（`lib/baseline/dataQuality.ts` と
 * 同じ分業）。
 *
 * ── rollup を読まない ───────────────────────────────────
 * 施設 1 件・1 か月の明細（種別別の中央値・ルール別の内訳）は rollup に
 * 無く、タスクの行から出すしかない。同じ画面で概要だけ rollup から
 * 取ると、集計の遅延で §1 と §2 の合計が食い違う。**全部を同じ行から
 * 出す**（施設 1 件・月 1 つに閉じた読み取りで、`collectDataQuality()` と
 * 同じ形。architecture.md §3 が禁じる横断集計ではない）。
 */

import {
  ITEM_CODES,
  listFindings,
  listObservations,
  listTasks,
  sumLinenByItemInRange,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  computeMonthlyReport,
  type MonthlyReport,
  type MonthlyReportFindingInput,
  type MonthlyReportTaskInput,
} from "@pk/engine";

import { monthRangeOf, type MonthRange } from "../baseline/dataQuality.js";

/**
 * `YYYY-MM` の前月。**日付ライブラリを使わず桁だけで戻す**
 * （タイムゾーンに触れると業務日の考え方と混線する）。
 */
export function previousMonthOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber === 1) return `${String(year - 1)}-12`;
  return `${String(year)}-${String(monthNumber - 1).padStart(2, "0")}`;
}

/** 1 か月ぶんのタスクと差異を engine の入力へ写す。 */
async function loadMonth(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  range: MonthRange,
): Promise<{
  tasks: MonthlyReportTaskInput[];
  findings: MonthlyReportFindingInput[];
}> {
  const [tasks, observations, findings] = await Promise.all([
    listTasks(env, ctx, {
      propertyId,
      businessDateFrom: range.from,
      businessDateTo: range.to,
    }),
    listObservations(env, ctx, { propertyId, from: range.from, to: range.to }),
    listFindings(env, ctx, { propertyId, from: range.from, to: range.to }),
  ]);

  const observedTaskIds = new Set(observations.map((row) => row.taskId));

  return {
    tasks: tasks.map((task) => ({
      taskType: task.taskType,
      status: task.status,
      actualMinutes: task.actualMinutes,
      inspectionResult: task.inspectionResult,
      reworkCount: task.reworkCount,
      hasObservation: observedTaskIds.has(task.id),
    })),
    findings: findings.map((finding) => ({
      ruleCode: finding.ruleCode,
      severity: finding.severity,
      status: finding.status,
    })),
  };
}

/**
 * 施設 1 つ・1 か月ぶんの月次レポート。
 *
 * 前月ぶんは前月比のためだけに読む。**組織を作った初月など前月の範囲が
 * 作れないことは無い**（`previousMonthOf()` は常に有効な月を返す）ので、
 * 前月は常に読み、行が無ければ engine が「0 件の月」として扱う。
 */
export async function collectMonthlyReport(
  env: Env,
  ctx: TenantContext,
  input: { propertyId: string; month: string; range: MonthRange },
): Promise<MonthlyReport> {
  const { propertyId, month, range } = input;

  const previousMonth = previousMonthOf(month);
  const previousRange = monthRangeOf(previousMonth);

  const [current, previous, linen] = await Promise.all([
    loadMonth(env, ctx, propertyId, range),
    previousRange === null
      ? Promise.resolve(null)
      : loadMonth(env, ctx, propertyId, previousRange),
    sumLinenByItemInRange(env, ctx, { propertyId, from: range.from, to: range.to }),
  ]);

  // 表示の並びは品目マスタの定義順（§2.5 の並び）。DB は辞書順で返す。
  const order = new Map(ITEM_CODES.map((code, index) => [code, index]));
  const sortedLinen = [...linen].sort(
    (a, b) => (order.get(a.itemCode) ?? ITEM_CODES.length) - (order.get(b.itemCode) ?? ITEM_CODES.length),
  );

  return computeMonthlyReport({
    month,
    from: range.from,
    to: range.to,
    tasks: current.tasks,
    findings: current.findings,
    linen: sortedLinen,
    previous,
  });
}
