/**
 * 負荷試験の目標値とシナリオ（PK-SPEC-P7 §4.1 / §4.2 / P7-12）。**純粋。**
 *
 * task:  docs/tasks/P7-12.md
 * ルール: .claude/rules/testing.md
 *
 * ── ここに fetch を持ち込まない ─────────────────────────
 * 実際に叩くのは `scripts/load-test.ts`。ここは
 * **「何を測り、どこを合格とするか」だけ**を持つ。`shardUsage.ts` と
 * 同じ割り方で、判定を node の外（テスト）から固定できるようにする。
 *
 * ── 目標値を 1 か所に置く ───────────────────────────────
 * §4.1 の表をそのまま定数にする。**CLI の中に数字を書かない。**
 * 仕様が動いたときに直す場所が 1 つになる。
 */

/** §4.1 の目標値。**単位はミリ秒。** */
export const PERF_TARGETS = {
  /** API p95（読み取り）< 300ms。 */
  apiReadP95Ms: 300,
  /** API p95（書き込み）< 500ms。 */
  apiWriteP95Ms: 500,
  /** モバイル初回表示（4G）< 2 秒。**実機で測る**（自動化しない）。 */
  mobileFirstPaintMs: 2000,
  /** 客室ボード表示（100 室）< 800ms。 */
  propertyBoardMs: 800,
  /** 照合バッチ（100 施設 5000 室）< 10 分。 */
  reconciliationBatchMs: 10 * 60 * 1000,
  /** 日報 PDF（100 室）< 30 秒。 */
  dailyReportPdfMs: 30 * 1000,
  /** 請求書 PDF < 15 秒。 */
  invoicePdfMs: 15 * 1000,
} as const;

/** §4.1「同時接続: 1 施設 30 名 × 100 施設」。 */
export const CONCURRENCY_TARGET = { propertiesPerOrg: 100, staffPerProperty: 30 } as const;

/** シナリオの識別子（§4.2）。 */
export const SCENARIO_IDS = ["A", "B", "C", "D"] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** どの目標値で合否を見るか。 */
export type ScenarioMetric = keyof typeof PERF_TARGETS;

/** シナリオ 1 つ（§4.2 の 4 つ）。 */
export interface Scenario {
  id: ScenarioId;
  /** 仕様の見出しそのまま。 */
  title: string;
  /** 何が集中するか（§4.2 の「→」の行）。 */
  pressure: string;
  /** 同時に動く仮想利用者の数。 */
  concurrency: number;
  /** 1 利用者あたりの繰り返し回数。 */
  iterations: number;
  /** 合否を見る目標値。 */
  metric: ScenarioMetric;
  /**
   * 実際に叩く経路。**`{propertyId}` などは CLI が埋める。**
   * 書き込みを含むシナリオは、**検証環境でだけ走らせること。**
   */
  paths: readonly string[];
  /** 自動化できない部分（あれば）。 */
  manualNote?: string;
}

/**
 * §4.2 の 4 シナリオ。**数字は仕様のまま。**
 *
 * ── C と D は「起動して待つ」形 ──────────────────────────
 * 照合バッチと請求 PDF は Queue の中で走る。HTTP のレイテンシではなく
 * **投入から完了までの時間**を測る。CLI は投入して状態を polling する。
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: "A",
    title: "朝のピーク",
    pressure: "09:00-10:00 に 100 施設 × 30 名が同時ログイン → タスク一覧取得が集中",
    // 100 施設 × 30 名。**仕様の同時接続の目標値そのもの。**
    concurrency: CONCURRENCY_TARGET.propertiesPerOrg * CONCURRENCY_TARGET.staffPerProperty,
    iterations: 5,
    metric: "apiReadP95Ms",
    paths: ["/api/v1/tasks/my-day?businessDate={businessDate}"],
  },
  {
    id: "B",
    title: "完了ラッシュ",
    pressure: "11:00-12:00 に 3,000 タスクが同時完了 → 写真アップロードと客室ステータス更新が集中",
    concurrency: 3000,
    iterations: 1,
    // 完了は書き込み。**読み取りの 300ms ではなく 500ms で見る。**
    metric: "apiWriteP95Ms",
    paths: ["/api/v1/tasks/{taskId}/complete"],
    manualNote: "写真アップロードの実体（500KB × 3,000）は実機の回線で測ること",
  },
  {
    id: "C",
    title: "夜間バッチ",
    pressure: "02:00 に 500 施設の照合バッチが起動 → D1 の読み書きが集中",
    // 仕様の目標値は「100 施設 5000 室で 10 分」。**500 施設はその 5 倍。**
    concurrency: 500,
    iterations: 1,
    metric: "reconciliationBatchMs",
    paths: ["/api/v1/reconciliation/runs"],
    manualNote: "目標値は 100 施設 5000 室ぶん。500 施設で測るなら 5 倍を許容とすること",
  },
  {
    id: "D",
    title: "月初の請求",
    pressure: "毎月 1 日に 200 通の請求書 PDF 生成と送付",
    concurrency: 200,
    iterations: 1,
    metric: "invoicePdfMs",
    paths: ["/api/v1/invoices/{invoiceId}/issue"],
  },
];

/** 計測の結果。**件数と分位だけ。** */
export interface ScenarioResult {
  id: ScenarioId;
  /** 成功した計測の数。 */
  samples: number;
  /** 応答が返らなかった数。**0 でなければ合格にしない。** */
  errors: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** 合否。 */
export type ScenarioVerdict =
  | { kind: "PASS"; targetMs: number }
  /** 目標値を超えた。 */
  | { kind: "FAIL"; targetMs: number; reason: "OVER_TARGET" }
  /** 応答が返らなかった。**速くても合格にしない。** */
  | { kind: "FAIL"; targetMs: number; reason: "ERRORS" }
  /** 計測できていない。**「合格」と「測っていない」を混ぜない。** */
  | { kind: "FAIL"; targetMs: number; reason: "NO_SAMPLES" };

/**
 * 合否を決める（§4.2 MUST「4 シナリオすべてで目標値を満たす」）。**純粋関数。**
 *
 * **境界は「未満」。** §4.1 が `< 300ms` と書いているので、
 * ちょうど 300ms は不合格に倒す。
 *
 * **エラーが 1 件でもあれば不合格。** 落ちた要求は速く返るので、
 * 分位だけを見ると「エラーが増えるほど速くなる」ことになる。
 */
export function evaluateScenario(scenario: Scenario, result: ScenarioResult): ScenarioVerdict {
  const targetMs = PERF_TARGETS[scenario.metric];
  if (result.samples === 0) return { kind: "FAIL", targetMs, reason: "NO_SAMPLES" };
  if (result.errors > 0) return { kind: "FAIL", targetMs, reason: "ERRORS" };
  if (result.p95Ms >= targetMs) return { kind: "FAIL", targetMs, reason: "OVER_TARGET" };
  return { kind: "PASS", targetMs };
}

/**
 * 分位を出す。**線形補間しない**（順位の値をそのまま採る）。
 *
 * 補間すると「実際には出ていない値」が報告に載る。負荷試験は
 * 「その値が出た要求が在るか」を見るものなので、実測値だけを返す。
 */
export function percentile(samplesMs: readonly number[], quantile: number): number {
  if (samplesMs.length === 0) return 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

/** 計測値からまとめを作る。 */
export function summarize(id: ScenarioId, samplesMs: readonly number[], errors: number): ScenarioResult {
  return {
    id,
    samples: samplesMs.length,
    errors,
    p50Ms: percentile(samplesMs, 0.5),
    p95Ms: percentile(samplesMs, 0.95),
    p99Ms: percentile(samplesMs, 0.99),
  };
}

/** 4 シナリオすべてが合格したか（§4.2 MUST）。 */
export function allScenariosPass(
  verdicts: ReadonlyMap<ScenarioId, ScenarioVerdict>,
): boolean {
  return SCENARIO_IDS.every((id) => verdicts.get(id)?.kind === "PASS");
}
