/**
 * 施設向け指標の算出（PK-SPEC-P2 §10.1）。**純粋関数。**
 *
 * task:  docs/tasks/P2-15.md
 * ルール: .claude/rules/security.md §5（従業員データ）
 * 契約:  docs/PK-IMPL-CONTRACT.md INV-01〜INV-03
 *
 * ── 集計単位は施設・客室タイプ・作業種別だけ ────────────
 * INV-03 が定めるとおり。**入力の型に担当者を持たせていない。**
 * `PropertyMetricsTaskInput` に `assigneeId` も `assigneeName` も無いので、
 * 個人別の率を出そうとすると、まず関数の形を変えることになる
 * （`ownWork.ts` と同じ塞ぎ方）。§10.3 の「20 タスク未満の個人指標を
 * 表示しない」は、**個人単位の指標をここで一切作らない**ことで満たす。
 * 本人が自分の記録を見る M-11 だけが個人単位で、そちらは
 * `MINIMUM_TASKS_FOR_AVERAGE`（`ownWork.ts`）が閾値を持っている。
 *
 * ── 日報のサマリーとは別物 ──────────────────────────────
 * `dailyReport.ts` の `DailyReportSummary` は**件数**で、その日に起きた
 * 事実そのもの。ここで出すのは**率と平均**で、事実から作った指標。
 * サマリーを率に変えないこと。日報は 1 業務日ぶんだが、指標は期間を跨ぐ。
 *
 * ── 「検査対象」の定義を日報と揃える ────────────────────
 * §10.1 の分母 4 つ（初回検査合格率・再清掃率・SLA 超過率・自己検査率）は
 * すべて「検査対象」。`inspectionRequired` の設定ではなく**実際に検査の
 * 記録があるタスク**を数える（`dailyReport.ts` 冒頭と同じ理由）。設定で
 * 数えると、抽出検査（§2.1 の `SAMPLE`）の施設で「検査対象 100 件・
 * 初回合格 12 件」という読めない率になる。
 *
 * ── 率は整数（千分率）で持つ ────────────────────────────
 * 画面は「91.4%」まで出す（§10.1 の例・PK-SPEC-P5 §7.1）。小数で持つと
 * 画面ごとに丸めが割れ、同じ指標が 91.4% と 91.5% で並ぶ。**千分率の
 * 整数**は 0.1pt 刻みの百分率とちょうど同じ精度で、丸めを 1 か所に閉じる。
 * 表示側は 10 で割るだけでよい。分母 0 は `null`（0% と区別する）。
 *
 * ── ここに時計を持ち込まない ────────────────────────────
 * 期間も SLA も引数で受け取る（CLAUDE.md §5）。
 */

/** §10.1 の 7 指標。**増やすときは仕様の表を先に変えること。** */
export const PROPERTY_METRIC_KEYS = [
  "completionRate",
  "firstPassRate",
  "reworkRate",
  "inspectionWaitMinutes",
  "actualMinutes",
  "slaBreachRate",
  "selfInspectionRate",
] as const;

export type PropertyMetricKey = (typeof PROPERTY_METRIC_KEYS)[number];

/**
 * 率 1 つ。**分子と分母をそのまま持つ。**
 *
 * 率だけを返すと「95% と言われても 19/20 なのか 950/1000 なのか
 * 分からない」状態になる。§10.3 の趣旨（少数データで誤解を招かない）は
 * 画面が母数を出せることに掛かっているので、値と一緒に運ぶ。
 */
export interface MetricRate {
  numerator: number;
  denominator: number;
  /** 千分率（0〜1000）。**分母が 0 なら `null`。** 表示は 10 で割る。 */
  permille: number | null;
}

/** 平均 1 つ。**母数 0 は `null`**（0 分と区別する）。 */
export interface MetricAverage {
  /** 平均を出せた件数。**母数。** */
  count: number;
  /** 平均（分）。四捨五入した整数。 */
  minutes: number | null;
}

// ────────────────────────────────────────────────────────────
// 入力（DB の行をそのまま渡さない。engine は @pk/db に依存しない）
// ────────────────────────────────────────────────────────────

/**
 * 期間内のタスク 1 件。
 *
 * **担当者を持たせない**（INV-03 / 冒頭の注記）。客室番号も要らない。
 * 指標は施設・客室タイプ・作業種別でしか分解しないため。
 */
export interface PropertyMetricsTaskInput {
  taskId: string;
  /** 作業種別（`CHECKOUT` など）。**平均実作業時間の分解軸。** */
  taskType: string;
  /** 客室タイプ。**同じく分解軸。** 共用部など客室に紐づかないものは `null`。 */
  roomTypeId: string | null;
  status: string;
  /** 清掃完了の時刻。**検査待ち時間の起点。** 未完了は `null`。 */
  completedAtMs: number | null;
  /** 実作業分。`null` は「計測できていない」。**0 分と区別する。** */
  actualMinutes: number | null;
}

/** タスクに紐づく検査。**ラウンドごとに 1 件。** 検査者は持たせない。 */
export interface PropertyMetricsInspectionInput {
  taskId: string;
  round: number;
  /** 未確定は `null`（検査中に期間が切れた場合）。 */
  result: string | null;
  /** 検査を開始した時刻。**検査待ち時間の終点。** */
  startedAtMs: number;
  selfApproved: boolean;
}

/** 差戻しサイクル。**件数だけを使う。** */
export interface PropertyMetricsReworkInput {
  taskId: string;
}

/** 1 施設・1 期間ぶんの入力。 */
export interface PropertyMetricsInput {
  /** 集計期間（業務日 `YYYY-MM-DD`）。**そのまま結果に写す。** */
  periodFrom: string;
  periodTo: string;
  /** 検査未着手の警告しきい値（分 / `propertyInspectionPolicy.inspectionSlaMinutes`）。 */
  slaMinutes: number;
  tasks: readonly PropertyMetricsTaskInput[];
  inspections: readonly PropertyMetricsInspectionInput[];
  reworks: readonly PropertyMetricsReworkInput[];
}

// ────────────────────────────────────────────────────────────
// 出力
// ────────────────────────────────────────────────────────────

/** 平均実作業時間の 1 グループ（§10.1「種別・客室タイプ別」）。 */
export interface WorkMinutesGroup {
  taskType: string;
  roomTypeId: string | null;
  average: MetricAverage;
}

/** §10.1 の 7 指標。 */
export interface PropertyMetrics {
  periodFrom: string;
  periodTo: string;
  slaMinutes: number;
  /** 完了率の分母（`CANCELLED` を除いたタスク数）。 */
  targetTasks: number;
  /** 4 つの率の分母（検査の記録があるタスク数）。 */
  inspectedTasks: number;
  /** ① 完了率。 */
  completionRate: MetricRate;
  /** ② 初回検査合格率。 */
  firstPassRate: MetricRate;
  /** ③ 再清掃率。 */
  reworkRate: MetricRate;
  /** ④ 平均検査待ち時間。 */
  inspectionWaitMinutes: MetricAverage;
  /** ⑤ 平均実作業時間（施設全体）。 */
  actualMinutes: MetricAverage;
  /** ⑤ 平均実作業時間（種別 × 客室タイプ）。 */
  actualMinutesByGroup: readonly WorkMinutesGroup[];
  /** ⑥ SLA 超過率。 */
  slaBreachRate: MetricRate;
  /** ⑦ 自己検査率。 */
  selfInspectionRate: MetricRate;
}

/**
 * 完了率の分母から外す状態。
 *
 * **`CANCELLED` は「できなかった作業」ではない。** 連泊への変更や
 * 予約取消でタスクごと不要になったもので、分母に残すと現場の手が
 * 届かない事情が未完了として率に乗る（§10.1 が「全タスク」ではなく
 * 「対象タスク」と書いている理由 / DECISIONS #088）。
 */
const EXCLUDED_FROM_TARGET = "CANCELLED";

/** 完了とみなす状態。**日報の数え方と同じ。** */
const COMPLETED_STATUS = "COMPLETED";

/** ミリ秒 → 分。 */
const MS_PER_MINUTE = 60_000;

/**
 * 率を組む。**分母 0 は `null`。**
 *
 * `permille` は千分率へ丸めた整数。`Math.round` は 0.5 を上へ寄せるので、
 * 同じ分子・分母なら常に同じ値になる（決定性）。
 *
 * @throws {RangeError} 分子・分母が非負の整数でないとき。
 */
export function metricRate(numerator: number, denominator: number): MetricRate {
  if (!Number.isInteger(numerator) || numerator < 0) {
    throw new RangeError(`METRIC_NUMERATOR_INVALID:${String(numerator)}`);
  }
  if (!Number.isInteger(denominator) || denominator < 0) {
    throw new RangeError(`METRIC_DENOMINATOR_INVALID:${String(denominator)}`);
  }
  return {
    numerator,
    denominator,
    permille: denominator === 0 ? null : Math.round((numerator * 1000) / denominator),
  };
}

/**
 * 平均を組む。**空なら `null`。**
 *
 * 入力は「計測できた値」だけを渡すこと。計測できていないものを 0 として
 * 混ぜると平均が実態より短くなる（`ownWork.ts` と同じ扱い）。
 */
export function metricAverage(values: readonly number[]): MetricAverage {
  if (values.length === 0) return { count: 0, minutes: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { count: values.length, minutes: Math.round(total / values.length) };
}

/** タスク ID ごとに集める。 */
function groupByTaskId<T extends { taskId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.taskId);
    if (bucket === undefined) grouped.set(row.taskId, [row]);
    else bucket.push(row);
  }
  return grouped;
}

/** ラウンドの昇順。**入力の順序に依存しない。** */
function firstRound(
  rounds: readonly PropertyMetricsInspectionInput[],
): PropertyMetricsInspectionInput | undefined {
  return rounds.reduce<PropertyMetricsInspectionInput | undefined>(
    (earliest, row) => (earliest === undefined || row.round < earliest.round ? row : earliest),
    undefined,
  );
}

/** 平均実作業時間の分解キー。`null` の客室タイプも 1 グループにする。 */
function groupKey(taskType: string, roomTypeId: string | null): string {
  return `${taskType} ${roomTypeId ?? ""}`;
}

/**
 * §10.1 の 7 指標を出す。**入力を書き換えない。**
 *
 * 期間の絞り込みは呼び出し側の責務。ここへ渡されたタスクがそのまま
 * 母集団になる。
 *
 * @throws {RangeError} `slaMinutes` が非負の整数でないとき。
 */
export function computePropertyMetrics(input: PropertyMetricsInput): PropertyMetrics {
  if (!Number.isInteger(input.slaMinutes) || input.slaMinutes < 0) {
    throw new RangeError(`METRIC_SLA_MINUTES_INVALID:${String(input.slaMinutes)}`);
  }

  const inspectionsByTask = groupByTaskId(input.inspections);
  const reworkedTaskIds = new Set(input.reworks.map((row) => row.taskId));

  let targetTasks = 0;
  let completedTasks = 0;
  let inspectedTasks = 0;
  let passedFirstRound = 0;
  let reworkedTasks = 0;
  let selfInspectedTasks = 0;
  let slaBreachedTasks = 0;

  const waitMinutes: number[] = [];
  const allActualMinutes: number[] = [];
  const byGroup = new Map<
    string,
    { taskType: string; roomTypeId: string | null; values: number[] }
  >();

  for (const task of input.tasks) {
    if (task.status !== EXCLUDED_FROM_TARGET) {
      targetTasks += 1;
      if (task.status === COMPLETED_STATUS) completedTasks += 1;
    }

    // 実作業時間は**記録があるものだけ**。取消は作業していないので外す。
    if (task.actualMinutes !== null && task.status !== EXCLUDED_FROM_TARGET) {
      allActualMinutes.push(task.actualMinutes);
      const key = groupKey(task.taskType, task.roomTypeId);
      const bucket = byGroup.get(key);
      if (bucket === undefined) {
        byGroup.set(key, {
          taskType: task.taskType,
          roomTypeId: task.roomTypeId,
          values: [task.actualMinutes],
        });
      } else bucket.values.push(task.actualMinutes);
    }

    const rounds = inspectionsByTask.get(task.taskId) ?? [];
    if (rounds.length === 0) continue;

    // ここから下は「検査対象」だけ（冒頭の注記）。
    inspectedTasks += 1;

    const first = firstRound(rounds);
    if (first?.result === "PASS") passedFirstRound += 1;
    if (reworkedTaskIds.has(task.taskId)) reworkedTasks += 1;
    if (rounds.some((round) => round.selfApproved)) selfInspectedTasks += 1;

    // ④ と ⑥ は同じ待ち時間から出す。**Round 1 だけ。** 2 回目以降の
    // 開始までの時間は再清掃の待ちで、検査の着手の遅さではない。
    if (first !== undefined && task.completedAtMs !== null) {
      const waited = Math.max(
        0,
        Math.round((first.startedAtMs - task.completedAtMs) / MS_PER_MINUTE),
      );
      waitMinutes.push(waited);
      // §5.2 と同じく「超えて」未着手。**ちょうどは超過にしない。**
      if (waited > input.slaMinutes) slaBreachedTasks += 1;
    }
  }

  const actualMinutesByGroup: WorkMinutesGroup[] = [...byGroup.values()]
    .map((bucket) => ({
      taskType: bucket.taskType,
      roomTypeId: bucket.roomTypeId,
      average: metricAverage(bucket.values),
    }))
    .sort(
      (a, b) =>
        a.taskType.localeCompare(b.taskType) ||
        (a.roomTypeId ?? "").localeCompare(b.roomTypeId ?? ""),
    );

  return {
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    slaMinutes: input.slaMinutes,
    targetTasks,
    inspectedTasks,
    completionRate: metricRate(completedTasks, targetTasks),
    firstPassRate: metricRate(passedFirstRound, inspectedTasks),
    reworkRate: metricRate(reworkedTasks, inspectedTasks),
    inspectionWaitMinutes: metricAverage(waitMinutes),
    actualMinutes: metricAverage(allActualMinutes),
    actualMinutesByGroup,
    // **分母は待ち時間を測れた件数。** 測れないタスクを分母に入れると、
    // 判定できなかったものが「SLA 内」として静かに率を下げる。
    slaBreachRate: metricRate(slaBreachedTasks, waitMinutes.length),
    selfInspectionRate: metricRate(selfInspectedTasks, inspectedTasks),
  };
}
