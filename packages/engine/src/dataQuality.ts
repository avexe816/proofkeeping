/**
 * 観察記録の入力品質（PK-SPEC-P3 §6.3 / W-22）。**純粋関数。**
 *
 * task:  docs/tasks/P3-12.md
 * ルール: .claude/rules/security.md §5（従業員データ）
 *
 * ── 5 指標 ──────────────────────────────────────────────
 *   入力率            観察記録のあるタスク / 対象タスク      目標 95%
 *   既定値のまま確定  `usedDefaults` / 観察記録             警告 90% 超
 *   平均入力時間      `inputDurationMs` の平均              目標 20 秒以内
 *   外れ値除外率      除外された観察 / 観察記録             警告 15% 超
 *   未記録率          「今回は記録しない」/ 対象タスク       警告 20% 超
 *
 * **入力率 + 未記録率は 100% にならない。** 記録もスキップもされないまま
 * 完了したタスクがあるため。片方から他方を引いて出さないこと。
 *
 * ── 評価に使わない（security.md §5 / INV-07）────────────
 * スタッフ別の入力率は §6.3 MUST が求めているので出すが、
 *   ① 対象期間 20 タスク未満は `display: false`（値を返しても画面に出さない）
 *   ② 入力率だけ。**所要時間・既定値率をスタッフ別に出さない**
 *   ③ 並べ替えの順位を持たせない（呼び出し側が並べる）
 * を守る。速さの比較になる指標を個人に割らないため。
 *
 * ── ここに時計を持ち込まない ────────────────────────────
 * 期間は呼び出し側が業務日で解決して渡す（CLAUDE.md §5）。
 */

import { metricRate, type MetricRate } from "./metrics.js";

/**
 * 平均入力時間。**ミリ秒。**
 *
 * `metrics.ts` の `MetricAverage` を使い回さないのは、あちらの値が
 * `minutes`（分）だから。同じ型で単位だけ違う値を運ぶと、画面が
 * 20 秒を 20 分として出す事故が起きる（§0.3 の出荷判定は秒の話）。
 */
export interface InputDurationAverage {
  /** 平均を出せた件数（`inputDurationMs` が計測できた観察の数）。 */
  count: number;
  /** 平均（ミリ秒）。四捨五入した整数。**母数 0 は `null`。** */
  averageMs: number | null;
}

/** §6.3 の目標・警告の値。**千分率**（`MetricRate.permille` と同じ尺度）。 */
export const DATA_QUALITY_THRESHOLDS = {
  /** 入力率の目標 95%。これを**下回る**と警告。 */
  inputRateTargetPermille: 950,
  /** 既定値のまま確定した割合の警告 90%。これを**上回る**と警告。 */
  defaultRateWarnPermille: 900,
  /** 平均入力時間の目標 20 秒（§0.3 の出荷判定と同じ）。**上回る**と警告。 */
  inputDurationTargetMs: 20_000,
  /** 外れ値除外率の警告 15%（§5.3 MUST）。**上回る**と警告。 */
  exclusionRateWarnPermille: 150,
  /** 未記録率の警告 20%（§1.3 / `observationConfig.skipWarnThreshold` の既定）。 */
  skipRateWarnPermille: 200,
} as const;

/**
 * 個人単位の指標を表示してよい最小のタスク数（security.md §5）。
 *
 * **下げないこと。** 5 件で 60% と出た数字は、1 件の記録漏れで 40% になる。
 */
export const MINIMUM_TASKS_FOR_STAFF_RATE = 20;

/** 指標 1 つの判定。**「異常」ではなく「通常と違う点」**（ui-writing.md §2）。 */
export type DataQualityStatus = "OK" | "WARN" | "UNKNOWN";

/** 1 施設・1 期間ぶんの入力率などを組み立てる入力（タスク 1 件）。 */
export interface DataQualityTaskInput {
  taskId: string;
  /** 観察記録がある（`roomObservation` の行がある）。 */
  hasObservation: boolean;
  /** 「今回は記録しない」で飛ばした（`cleaningTask.observationSkipped`）。 */
  observationSkipped: boolean;
  /** 担当者の `membership.id`。未割当は `null`。 */
  assigneeId: string | null;
}

/** 観察記録 1 件ぶんの入力（既定値率・入力時間の母数）。 */
export interface DataQualityObservationInput {
  observationId: string;
  usedDefaults: boolean;
  /** 未計測は `null`（平均の母数に入れない）。 */
  inputDurationMs: number | null;
}

export interface DataQualityInput {
  tasks: readonly DataQualityTaskInput[];
  observations: readonly DataQualityObservationInput[];
  /**
   * ベースライン集計で除外された観察の **ID**（`baselineExclusionLog`）。
   *
   * **件数ではなく ID を渡す。** 1 つの観察が複数の品目で除外されるため、
   * 行数を数えると 100% を超えうる（docs/DECISIONS.md #102）。
   */
  excludedObservationIds: readonly string[];
  /** ベースラインの成熟度（§6.3 の下段）。 */
  baselines: readonly DataQualityBaselineInput[];
}

/** ベースライン 1 行（成熟度の母数）。 */
export interface DataQualityBaselineInput {
  roomTypeId: string;
  guestCount: number;
  isReliable: boolean;
}

/** スタッフ 1 人ぶんの入力率。**入力率だけ**（冒頭の注記②）。 */
export interface StaffInputRate {
  assigneeId: string;
  rate: MetricRate;
  /**
   * 画面に出してよいか（`denominator >= 20` / security.md §5）。
   *
   * **偽なら率を表示しない。** 値そのものは返す（画面が「20 件未満」と
   * 出せるように母数は使う）。
   */
  display: boolean;
}

/** 客室タイプ × 人数の組み合わせ 1 つ。 */
export interface BaselineMaturityCombination {
  roomTypeId: string;
  guestCount: number;
  itemCount: number;
  reliableItemCount: number;
  /** **すべての品目行が信頼可能なときだけ真**（下の注記）。 */
  isReliable: boolean;
}

/** §6.3 下段「ベースライン成熟度」。 */
export interface BaselineMaturity {
  combinations: BaselineMaturityCombination[];
  reliableCount: number;
  totalCount: number;
}

export interface DataQuality {
  inputRate: MetricRate;
  defaultRate: MetricRate;
  inputDuration: InputDurationAverage;
  exclusionRate: MetricRate;
  skipRate: MetricRate;
  staffInputRates: StaffInputRate[];
  maturity: BaselineMaturity;
}

/**
 * 平均を組む。**空なら `null`**（0 ミリ秒と区別する）。
 *
 * 計測できていないものを 0 として混ぜないこと（`metricAverage()` と同じ扱い）。
 */
function averageMs(values: readonly number[]): InputDurationAverage {
  if (values.length === 0) return { count: 0, averageMs: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { count: values.length, averageMs: Math.round(total / values.length) };
}

/** 目標を**下回る**と警告になる指標（入力率）。 */
function statusForFloor(rate: MetricRate, targetPermille: number): DataQualityStatus {
  if (rate.permille === null) return "UNKNOWN";
  return rate.permille >= targetPermille ? "OK" : "WARN";
}

/** 閾値を**上回る**と警告になる指標（既定値率・除外率・未記録率）。 */
function statusForCeiling(rate: MetricRate, warnPermille: number): DataQualityStatus {
  if (rate.permille === null) return "UNKNOWN";
  return rate.permille <= warnPermille ? "OK" : "WARN";
}

/** 5 指標の判定。**画面はこれを読むだけにする**（閾値を画面に置かない）。 */
export function dataQualityStatuses(quality: DataQuality): Record<string, DataQualityStatus> {
  return {
    inputRate: statusForFloor(quality.inputRate, DATA_QUALITY_THRESHOLDS.inputRateTargetPermille),
    defaultRate: statusForCeiling(
      quality.defaultRate,
      DATA_QUALITY_THRESHOLDS.defaultRateWarnPermille,
    ),
    inputDuration:
      quality.inputDuration.averageMs === null
        ? "UNKNOWN"
        : quality.inputDuration.averageMs <= DATA_QUALITY_THRESHOLDS.inputDurationTargetMs
          ? "OK"
          : "WARN",
    exclusionRate: statusForCeiling(
      quality.exclusionRate,
      DATA_QUALITY_THRESHOLDS.exclusionRateWarnPermille,
    ),
    skipRate: statusForCeiling(quality.skipRate, DATA_QUALITY_THRESHOLDS.skipRateWarnPermille),
  };
}

/**
 * 客室タイプ × 人数の成熟度（§6.3 下段）。
 *
 * **組み合わせが信頼可能 = その組み合わせの全品目行が `isReliable`。**
 * 観察は 1 タスクで全品目をまとめて記録するため、同じ組み合わせの
 * 品目行はほぼ同じサンプル数になる。「全品目が 20 件以上」は
 * 実質「その組み合わせを 20 回以上観察した」であり、P3-13 の
 * 出荷判定（「80% 以上で `isReliable = true`」）と同じ意味になる。
 */
function computeMaturity(baselines: readonly DataQualityBaselineInput[]): BaselineMaturity {
  const groups = new Map<string, BaselineMaturityCombination>();
  for (const row of baselines) {
    const key = `${row.roomTypeId}|${String(row.guestCount)}`;
    const current = groups.get(key) ?? {
      roomTypeId: row.roomTypeId,
      guestCount: row.guestCount,
      itemCount: 0,
      reliableItemCount: 0,
      isReliable: false,
    };
    current.itemCount += 1;
    if (row.isReliable) current.reliableItemCount += 1;
    groups.set(key, current);
  }

  const combinations = [...groups.values()].map((combination) => ({
    ...combination,
    isReliable: combination.itemCount > 0 && combination.reliableItemCount === combination.itemCount,
  }));
  // 決定性のため、入力順ではなくキー順で返す（`computeBaseline()` と同じ）。
  combinations.sort((a, b) => {
    if (a.roomTypeId !== b.roomTypeId) return a.roomTypeId < b.roomTypeId ? -1 : 1;
    return a.guestCount - b.guestCount;
  });

  return {
    combinations,
    reliableCount: combinations.filter((combination) => combination.isReliable).length,
    totalCount: combinations.length,
  };
}

/**
 * スタッフ別の入力率（§6.3 MUST）。**担当者が付いたタスクだけ。**
 *
 * 未割当（`assigneeId === null`）のタスクは分母にも分子にも入れない。
 * 「誰の入力率か」を言えないため。
 */
function computeStaffRates(tasks: readonly DataQualityTaskInput[]): StaffInputRate[] {
  const counters = new Map<string, { numerator: number; denominator: number }>();
  for (const task of tasks) {
    if (task.assigneeId === null) continue;
    const current = counters.get(task.assigneeId) ?? { numerator: 0, denominator: 0 };
    current.denominator += 1;
    if (task.hasObservation) current.numerator += 1;
    counters.set(task.assigneeId, current);
  }

  const rates = [...counters.entries()].map(([assigneeId, counts]) => ({
    assigneeId,
    rate: metricRate(counts.numerator, counts.denominator),
    display: counts.denominator >= MINIMUM_TASKS_FOR_STAFF_RATE,
  }));
  // **順位を持たせない**（冒頭の注記③）。ID の昇順で返し、画面が並べる。
  rates.sort((a, b) => (a.assigneeId < b.assigneeId ? -1 : a.assigneeId > b.assigneeId ? 1 : 0));
  return rates;
}

/**
 * 入力品質を算出する（§6.3）。
 *
 * 外れ値除外率の母数は**観察記録の件数**で、分子は「いずれかの品目で
 * 除外された観察の数」。品目ごとの行数で割らないのは、行数の母数
 * （観察 × 有効品目）が施設設定で変わり、施設どうしで比べられなく
 * なるため（docs/DECISIONS.md #102）。
 */
export function computeDataQuality(input: DataQualityInput): DataQuality {
  const taskCount = input.tasks.length;
  const observedCount = input.tasks.filter((task) => task.hasObservation).length;
  const skippedCount = input.tasks.filter((task) => task.observationSkipped).length;

  const observationCount = input.observations.length;
  const defaultCount = input.observations.filter((observation) => observation.usedDefaults).length;
  const durations = input.observations
    .map((observation) => observation.inputDurationMs)
    .filter((value): value is number => value !== null);

  // 同じ観察が複数の品目で除外されても 1 件と数える（冒頭の注記）。
  const excluded = new Set(input.excludedObservationIds);
  const observationIds = new Set(input.observations.map((observation) => observation.observationId));
  let excludedCount = 0;
  for (const id of excluded) {
    if (observationIds.has(id)) excludedCount += 1;
  }

  return {
    inputRate: metricRate(observedCount, taskCount),
    defaultRate: metricRate(defaultCount, observationCount),
    inputDuration: averageMs(durations),
    exclusionRate: metricRate(excludedCount, observationCount),
    skipRate: metricRate(skippedCount, taskCount),
    staffInputRates: computeStaffRates(input.tasks),
    maturity: computeMaturity(input.baselines),
  };
}
