/**
 * テナントの記録の品質（PF-02 / プロトタイプ `pkplat-A-status-tenants` 03）。
 *
 * task: docs/tasks/PF-02.md
 *
 * ── 判定の逐語 ──────────────────────────────────────────
 * > 判定は3指標の組み合わせです。完備率90%未満・既定値70%超・入力時間10秒未満の
 * > うち2つ以上該当で「要支援」とします。
 *
 * **1 つでは判定しない。** どの指標も単独では別の説明が付く —
 * 完備率が低いのは繁忙期かもしれず、入力が速いのは慣れかもしれず、
 * 既定値のままなのは既定が当たっているからかもしれない。
 * 2 つ重なって初めて「入力が形骸化している可能性」になる。
 *
 * ── 閾値を持ち込まない ──────────────────────────────────
 * 3 つのうち 2 つ（入力所要時間・既定値のまま比率）は PF-14 の
 * 「運用（変更可）」から来る。**引数で受け取る。**
 * 完備率の 90% だけは PF-14 の 5 項目に無いので定数で持つ
 * （プロトタイプが上限 — 編集できる設定を勝手に増やさない）。
 *
 * ── 純粋関数 ────────────────────────────────────────────
 * DB・fetch・環境変数・`Date.now()` を持ち込まない（CLAUDE.md §5）。
 */

/**
 * 完備率の閾値（%）。**これ未満が該当。**
 *
 * PF-14 の「運用（変更可）」5 項目に無いので、**コード上の定数のまま。**
 * 変えるには PK-SPEC-UI の改訂手続が要る（PF-14 の左カラムと同じ扱い）。
 */
export const COMPLETENESS_THRESHOLD_PERCENT = 90;

/** 「要支援」に必要な該当数。**2 つ以上**（逐語）。 */
export const SUPPORT_SIGNAL_COUNT = 2;

/** 判定に使う閾値。PF-14 の「運用（変更可）」から渡す。 */
export interface TenantQualityThresholds {
  /** 入力所要時間の基準（秒）。**これ未満が該当。** 既定 10。 */
  inputDurationFloorSeconds: number;
  /** 既定値のまま比率の閾値（%）。**これを超えたら該当。** 既定 70。 */
  defaultRateThresholdPercent: number;
}

/** 数え上げた素の値（`platform_tenant_snapshot` の列そのまま）。 */
export interface TenantQualityCounts {
  /** 完備率の分母。その業務日に完了したタスク数。 */
  completedTasks: number;
  /** 完備率の分子。観察記録が入ったタスク数。 */
  observationsRecorded: number;
  /** そのうち既定値のまま確定した数。 */
  observationsUsedDefaults: number;
  /** 入力所要時間の中央値（ミリ秒）。計測が 1 件も無ければ `null`。 */
  inputDurationMedianMs: number | null;
}

/** 3 指標のどれが該当したか。**画面は理由を並べられる。** */
export interface TenantQualitySignals {
  lowCompleteness: boolean;
  highDefaultRate: boolean;
  fastInput: boolean;
}

export interface TenantQualityVerdict {
  /**
   * 完備率（%）。**分母が 0 なら `null`**（0% ではない）。
   * 「まだ無い」と「全部落ちている」を混ぜない。
   */
  completenessPercent: number | null;
  /** 既定値のまま比率（%）。記録が 0 件なら `null`。 */
  defaultRatePercent: number | null;
  signals: TenantQualitySignals;
  /** 該当した指標の数（0〜3）。 */
  signalCount: number;
  /** 2 つ以上該当で真。**この語は画面に出す語彙**（「要支援」）。 */
  needsSupport: boolean;
}

/**
 * 百分率を出す。**整数で返す**（小数点以下は切り捨て / 浮動小数点で持たない）。
 *
 * 分母が 0 なら `null`。**0 を返さない** — 「記録すべきものが無かった日」を
 * 「完備率 0% の日」として扱うと、稼働していないテナントが全部「要支援」になる。
 */
function percentOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.floor((numerator * 100) / denominator);
}

/**
 * 記録の品質を判定する。
 *
 * **値が無い指標は該当としない。** 完備率が出せない（完了タスクが 0）、
 * 入力所要時間の計測が無い、といった日を「悪い」側に倒さない。
 * 判定は 3 指標のうち**確かに悪いと言えるもの**だけを数える。
 */
export function judgeTenantQuality(
  counts: TenantQualityCounts,
  thresholds: TenantQualityThresholds,
): TenantQualityVerdict {
  const completenessPercent = percentOf(counts.observationsRecorded, counts.completedTasks);
  const defaultRatePercent = percentOf(
    counts.observationsUsedDefaults,
    counts.observationsRecorded,
  );

  const signals: TenantQualitySignals = {
    // 「完備率 90% 未満」。出せない日は該当しない。
    lowCompleteness:
      completenessPercent !== null && completenessPercent < COMPLETENESS_THRESHOLD_PERCENT,
    // 「既定値 70% 超」。**超えたら**なので、ちょうど 70 は該当しない。
    highDefaultRate:
      defaultRatePercent !== null && defaultRatePercent > thresholds.defaultRateThresholdPercent,
    // 「入力時間 10 秒未満」。計測が無い日は該当しない。
    fastInput:
      counts.inputDurationMedianMs !== null &&
      counts.inputDurationMedianMs < thresholds.inputDurationFloorSeconds * 1000,
  };

  const signalCount = Number(signals.lowCompleteness) + Number(signals.highDefaultRate) + Number(signals.fastInput);

  return {
    completenessPercent,
    defaultRatePercent,
    signals,
    signalCount,
    needsSupport: signalCount >= SUPPORT_SIGNAL_COUNT,
  };
}

/**
 * 中央値（ミリ秒）。**空なら `null`。**
 *
 * スナップショットを作るときに使う。偶数個なら中間 2 つの平均を
 * **切り捨てた整数**にする（浮動小数点を持ち回らない）。
 * 引数は破壊しない（呼び出し側の配列を並べ替えない）。
 */
export function medianDurationMs(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (low === undefined || high === undefined) return null;
  return Math.floor((low + high) / 2);
}
