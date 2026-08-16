/**
 * 月次レポートの集計（owner 09）。**純粋関数。**
 *
 * 参照:  ui-prototypes/owner/pkown-v3-C-inspection-linen-report.html（09）
 * 台帳:  docs/PROTOTYPE_GAP.md 第2批 09 / DECISIONS #196
 * ルール: .claude/rules/ui-writing.md §2（禁止語）/ security.md §5（従業員データ）
 *
 * ── 帳票ではない ────────────────────────────────────────
 * 請求書・領収書と違い、**発行・採番・スナップショットをしない**
 * （DECISIONS #196）。開いた時点の記録から毎回作り直す画面で、
 * `DocumentSequencer` にも R2 にも触れない。だからこの関数は
 * 「同じ入力なら同じ出力」だけを保証すればよい。
 *
 * ── 数え方は既存の定義から変えない ──────────────────────
 * - 記録の完備率: 観察記録があるタスク ÷ その月の全タスク。
 *   分母・分子とも `computeDataQuality()` の入力率と同じ
 *   （`collectDataQuality()` の「その月に立ったタスクをそのまま数える」）。
 * - 再清掃率: 差戻しを受けたタスク ÷ 検査結果が確定したタスク。
 *   分母は §10.1 の「検査対象」（`metrics.ts` 冒頭の注記と同じ理由。
 *   完了数を分母にすると抽出率の上げ下げで率が動く）。
 * - 差異率: 差異の件数 ÷ 完了タスク。**目標 0% の指標ではない**
 *   （プロトタイプの注記。画面が但し書きを常設する）。
 *
 * ── 個人単位の集計を作らない（INV-03 / security.md §5）────
 * 入力の型に担当者を持たせていない。分解軸は作業種別と品目だけ。
 *
 * ── 抑制された差異を載せない ────────────────────────────
 * `SUPPRESSED` は設定で「出さない」と決めた差異で、外へ渡りうる文書に
 * 載せると設定の意味が無くなる。件数からも除く（呼び出し側ではなく
 * ここで除くのは、定義を 1 か所でテストするため）。
 */

import { metricRate, type MetricRate } from "./metrics.js";

// ────────────────────────────────────────────────────────────
// 入力（DB の行をそのまま渡さない。engine は @pk/db に依存しない）
// ────────────────────────────────────────────────────────────

/** その月のタスク 1 件。**担当者・客室を持たせない**（冒頭の注記）。 */
export interface MonthlyReportTaskInput {
  taskType: string;
  status: string;
  /** 実作業分。`null` は「計測できていない」。**0 分と区別する。** */
  actualMinutes: number | null;
  /** 検査の結果（`PASS` / `FAIL`）。検査に回らなかったタスクは `null`。 */
  inspectionResult: string | null;
  reworkCount: number;
  /** 観察記録（入室時の記録）があるか。 */
  hasObservation: boolean;
}

/** その月の差異 1 件。 */
export interface MonthlyReportFindingInput {
  ruleCode: string;
  severity: string;
  status: string;
}

/** 品目 1 つぶんのリネン集計（回収・補充の合計枚数）。 */
export interface MonthlyReportLinenInput {
  itemCode: string;
  collectedQty: number;
  suppliedQty: number;
}

export interface MonthlyReportInput {
  /** 対象月（`YYYY-MM`）。**そのまま結果に写す。** */
  month: string;
  /** 業務日の閉区間（`YYYY-MM-DD`）。 */
  from: string;
  to: string;
  tasks: readonly MonthlyReportTaskInput[];
  findings: readonly MonthlyReportFindingInput[];
  linen: readonly MonthlyReportLinenInput[];
  /** 前月比のための前月ぶん。**組織の初月などで無ければ `null`。** */
  previous: {
    tasks: readonly MonthlyReportTaskInput[];
    findings: readonly MonthlyReportFindingInput[];
  } | null;
}

// ────────────────────────────────────────────────────────────
// 出力
// ────────────────────────────────────────────────────────────

/**
 * 件数 1 つと前月比。
 *
 * `changePermille` は増減の千分率（+42 = +4.2%）。**前月が 0 件・前月の
 * 入力が無いときは `null`**（「±0%」と区別する。0 で割らない）。
 */
export interface MonthlyCount {
  count: number;
  changePermille: number | null;
}

/**
 * 率 1 つと前月比。
 *
 * `changePermille` は千分率の差（+6 = +0.6pt）。どちらかの分母が 0 なら
 * `null`。**比ではなく差**にしてあるのは、率の前月比を比で出すと
 * 「1% → 2% が +100%」という読めない数字になるため。
 */
export interface MonthlyRate {
  rate: MetricRate;
  changePermille: number | null;
}

/** 作業種別 1 つぶん（§2 清掃の実施状況）。 */
export interface MonthlyTaskTypeRow {
  taskType: string;
  /** 完了した件数。 */
  completedCount: number;
  /** 実作業分の中央値。**計測できた完了タスクが無ければ `null`。** */
  medianMinutes: number | null;
}

/** ルール 1 つぶん（§3 稼働の差異）。 */
export interface MonthlyFindingRow {
  ruleCode: string;
  /** そのルールで最も高い重要度（`HIGH` > `MEDIUM` > `LOW`）。 */
  severity: string;
  totalCount: number;
  /** 確認が済んだ件数（`RESOLVED` / `FALSE_POSITIVE`）。 */
  reviewedCount: number;
}

/** 品目 1 つぶん（§5 リネンの消費）。`delta = 補充 − 回収`。 */
export interface MonthlyLinenRow {
  itemCode: string;
  collectedQty: number;
  suppliedQty: number;
  delta: number;
}

export interface MonthlyReport {
  month: string;
  from: string;
  to: string;
  /** §1 今月の概要。 */
  summary: {
    completedTasks: MonthlyCount;
    /** 観察記録があるタスクの割合。 */
    recordRate: MonthlyRate;
    /** 差異の件数 ÷ 完了タスク。**目標 0% の指標ではない。** */
    findingRate: MonthlyRate;
    /** 差戻しを受けたタスク ÷ 検査結果が確定したタスク。 */
    reworkRate: MonthlyRate;
  };
  /** §2 清掃の実施状況。**完了件数の多い順。** */
  taskTypes: readonly MonthlyTaskTypeRow[];
  /** §3 稼働の差異。**重要度の高い順 → 件数の多い順。** 抑制済みを含まない。 */
  findingsByRule: readonly MonthlyFindingRow[];
  /** §4 検査と再清掃。 */
  inspection: {
    /** 検査の結果が確定したタスク数。 */
    inspectedTasks: number;
    /** そのうち合格（差戻し後の合格も含む）。 */
    passedTasks: number;
    /** 合格 ÷ 検査。 */
    passRate: MetricRate;
    /** 検査 ÷ 完了（抜き取りの割合）。 */
    inspectionCoverage: MetricRate;
    /** 差戻しを受けたタスク数。 */
    reworkTasks: number;
  };
  /** §5 リネンの消費。**入力の順序を保つ**（並びは呼び出し側が決める）。 */
  linen: readonly MonthlyLinenRow[];
  linenTotals: { collectedQty: number; suppliedQty: number; delta: number };
}

// ────────────────────────────────────────────────────────────
// 実装
// ────────────────────────────────────────────────────────────

const COMPLETED = "COMPLETED";

/** 検査の結果として数える値（`countTasksForRollup()` と同じ集合）。 */
const INSPECTION_RESULTS = new Set(["PASS", "FAIL"]);

/** 確認が済んだとみなす差異の状態（§6.3 の 2 つの終端）。 */
const REVIEWED_FINDING_STATUSES = new Set(["RESOLVED", "FALSE_POSITIVE"]);

/** レポートに載せない差異の状態（冒頭の注記）。 */
const EXCLUDED_FINDING_STATUS = "SUPPRESSED";

/** 重要度の並び。**表に無い値は最後。** */
const SEVERITY_ORDER = ["HIGH", "MEDIUM", "LOW"] as const;

function severityRank(severity: string): number {
  const index = (SEVERITY_ORDER as readonly string[]).indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/**
 * 中央値（分）。偶数個なら中央 2 つの平均を四捨五入。
 *
 * 平均ではなく中央値なのはプロトタイプの表のとおり。1 件の長い作業
 * （設備待ちなど）で月の代表値が動かないようにする意図を汲む。
 */
export function medianMinutes(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

/** 件数の前月比（増減の千分率）。前月 0・前月なしは `null`。 */
function countChange(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(((current - previous) * 1000) / previous);
}

/** 率の前月比（千分率の差）。どちらかが `null` なら `null`。 */
function rateChange(current: MetricRate, previous: MetricRate | null): number | null {
  if (previous === null || current.permille === null || previous.permille === null) return null;
  return current.permille - previous.permille;
}

/** 1 か月ぶんのタスクから出す基礎値。当月と前月で同じ数え方をする。 */
interface TaskCounts {
  total: number;
  completed: number;
  observed: number;
  inspected: number;
  passed: number;
  rework: number;
}

function countTasks(tasks: readonly MonthlyReportTaskInput[]): TaskCounts {
  let completed = 0;
  let observed = 0;
  let inspected = 0;
  let passed = 0;
  let rework = 0;
  for (const task of tasks) {
    if (task.status === COMPLETED) completed += 1;
    if (task.hasObservation) observed += 1;
    if (task.inspectionResult !== null && INSPECTION_RESULTS.has(task.inspectionResult)) {
      inspected += 1;
      if (task.inspectionResult === "PASS") passed += 1;
    }
    if (task.reworkCount > 0) rework += 1;
  }
  return { total: tasks.length, completed, observed, inspected, passed, rework };
}

/** 抑制済みを除いた差異。**この関数以外で除かない**（定義を 1 か所に）。 */
function visibleFindings(
  findings: readonly MonthlyReportFindingInput[],
): readonly MonthlyReportFindingInput[] {
  return findings.filter((finding) => finding.status !== EXCLUDED_FINDING_STATUS);
}

export function computeMonthlyReport(input: MonthlyReportInput): MonthlyReport {
  const counts = countTasks(input.tasks);
  const findings = visibleFindings(input.findings);

  const previousCounts = input.previous === null ? null : countTasks(input.previous.tasks);
  const previousFindings =
    input.previous === null ? null : visibleFindings(input.previous.findings);

  const recordRate = metricRate(counts.observed, counts.total);
  const findingRate = metricRate(findings.length, counts.completed);
  const reworkRate = metricRate(counts.rework, counts.inspected);

  // ── §2 作業種別 ──────────────────────────────────────
  const byType = new Map<string, { completedCount: number; minutes: number[] }>();
  for (const task of input.tasks) {
    if (task.status !== COMPLETED) continue;
    const bucket = byType.get(task.taskType) ?? { completedCount: 0, minutes: [] };
    bucket.completedCount += 1;
    if (task.actualMinutes !== null) bucket.minutes.push(task.actualMinutes);
    byType.set(task.taskType, bucket);
  }
  const taskTypes: MonthlyTaskTypeRow[] = [...byType.entries()]
    .map(([taskType, bucket]) => ({
      taskType,
      completedCount: bucket.completedCount,
      medianMinutes: medianMinutes(bucket.minutes),
    }))
    .sort(
      (a, b) => b.completedCount - a.completedCount || a.taskType.localeCompare(b.taskType),
    );

  // ── §3 ルール別 ──────────────────────────────────────
  const byRule = new Map<string, { severities: string[]; total: number; reviewed: number }>();
  for (const finding of findings) {
    const bucket = byRule.get(finding.ruleCode) ?? { severities: [], total: 0, reviewed: 0 };
    bucket.severities.push(finding.severity);
    bucket.total += 1;
    if (REVIEWED_FINDING_STATUSES.has(finding.status)) bucket.reviewed += 1;
    byRule.set(finding.ruleCode, bucket);
  }
  const findingsByRule: MonthlyFindingRow[] = [...byRule.entries()]
    .map(([ruleCode, bucket]) => ({
      ruleCode,
      severity: [...bucket.severities].sort((a, b) => severityRank(a) - severityRank(b))[0] as string,
      totalCount: bucket.total,
      reviewedCount: bucket.reviewed,
    }))
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        b.totalCount - a.totalCount ||
        a.ruleCode.localeCompare(b.ruleCode),
    );

  // ── §5 リネン ────────────────────────────────────────
  const linen: MonthlyLinenRow[] = input.linen.map((row) => ({
    itemCode: row.itemCode,
    collectedQty: row.collectedQty,
    suppliedQty: row.suppliedQty,
    delta: row.suppliedQty - row.collectedQty,
  }));
  const linenTotals = linen.reduce(
    (totals, row) => ({
      collectedQty: totals.collectedQty + row.collectedQty,
      suppliedQty: totals.suppliedQty + row.suppliedQty,
      delta: totals.delta + row.delta,
    }),
    { collectedQty: 0, suppliedQty: 0, delta: 0 },
  );

  return {
    month: input.month,
    from: input.from,
    to: input.to,
    summary: {
      completedTasks: {
        count: counts.completed,
        changePermille: countChange(counts.completed, previousCounts?.completed ?? null),
      },
      recordRate: {
        rate: recordRate,
        changePermille: rateChange(
          recordRate,
          previousCounts === null ? null : metricRate(previousCounts.observed, previousCounts.total),
        ),
      },
      findingRate: {
        rate: findingRate,
        changePermille: rateChange(
          findingRate,
          previousCounts === null || previousFindings === null
            ? null
            : metricRate(previousFindings.length, previousCounts.completed),
        ),
      },
      reworkRate: {
        rate: reworkRate,
        changePermille: rateChange(
          reworkRate,
          previousCounts === null
            ? null
            : metricRate(previousCounts.rework, previousCounts.inspected),
        ),
      },
    },
    taskTypes,
    findingsByRule,
    inspection: {
      inspectedTasks: counts.inspected,
      passedTasks: counts.passed,
      passRate: metricRate(counts.passed, counts.inspected),
      inspectionCoverage: metricRate(counts.inspected, counts.completed),
      reworkTasks: counts.rework,
    },
    linen,
    linenTotals,
  };
}
