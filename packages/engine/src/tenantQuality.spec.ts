/**
 * テナントの記録の品質（PF-02）。
 *
 * ルール: .claude/rules/testing.md §3（純粋関数は正例・負例を 5 件ずつ）
 *
 * 判定の逐語:
 * > 完備率90%未満・既定値70%超・入力時間10秒未満のうち2つ以上該当で「要支援」
 */

import { describe, expect, it } from "vitest";

import {
  COMPLETENESS_THRESHOLD_PERCENT,
  judgeTenantQuality,
  medianDurationMs,
  SUPPORT_SIGNAL_COUNT,
  type TenantQualityCounts,
  type TenantQualityThresholds,
} from "./tenantQuality.js";

/** PF-14 の既定（10 秒 / 70%）。 */
const THRESHOLDS: TenantQualityThresholds = {
  inputDurationFloorSeconds: 10,
  defaultRateThresholdPercent: 70,
};

/** 健全なテナント（完備率 98% / 既定値 20% / 19 秒）。 */
const HEALTHY: TenantQualityCounts = {
  completedTasks: 100,
  observationsRecorded: 98,
  observationsUsedDefaults: 20,
  inputDurationMedianMs: 19_000,
};

function judge(overrides: Partial<TenantQualityCounts> = {}) {
  return judgeTenantQuality({ ...HEALTHY, ...overrides }, THRESHOLDS);
}

describe("judgeTenantQuality: 要支援になる（正例 5 件）", () => {
  it("完備率 74% ＋ 入力 8 秒（プロトタイプの沖縄ホスピタリティ）", () => {
    const result = judge({ observationsRecorded: 74, inputDurationMedianMs: 8_000 });
    expect(result.signals).toEqual({
      lowCompleteness: true,
      highDefaultRate: false,
      fastInput: true,
    });
    expect(result.needsSupport).toBe(true);
  });

  it("完備率 80% ＋ 既定値 91%（3 指標のうち 2 つ）", () => {
    const result = judge({ observationsRecorded: 80, observationsUsedDefaults: 73 });
    expect(result.completenessPercent).toBe(80);
    expect(result.defaultRatePercent).toBe(91);
    expect(result.needsSupport).toBe(true);
  });

  it("既定値 90% ＋ 入力 5 秒（完備率は良い）", () => {
    const result = judge({ observationsUsedDefaults: 89, inputDurationMedianMs: 5_000 });
    expect(result.signals.lowCompleteness).toBe(false);
    expect(result.needsSupport).toBe(true);
  });

  it("3 指標すべて該当", () => {
    const result = judge({
      observationsRecorded: 50,
      observationsUsedDefaults: 45,
      inputDurationMedianMs: 2_000,
    });
    expect(result.signalCount).toBe(3);
    expect(result.needsSupport).toBe(true);
  });

  it("境界のすぐ内側（完備率 89% ＋ 入力 9,999ms）", () => {
    const result = judge({ observationsRecorded: 89, inputDurationMedianMs: 9_999 });
    expect(result.signalCount).toBe(SUPPORT_SIGNAL_COUNT);
    expect(result.needsSupport).toBe(true);
  });
});

describe("judgeTenantQuality: 要支援にならない（負例 5 件）", () => {
  it("健全なテナントは 1 つも該当しない", () => {
    const result = judge();
    expect(result.signalCount).toBe(0);
    expect(result.needsSupport).toBe(false);
  });

  it("**1 つだけ該当では要支援にしない**（完備率 74%）", () => {
    const result = judge({ observationsRecorded: 74 });
    expect(result.signals.lowCompleteness).toBe(true);
    expect(result.signalCount).toBe(1);
    expect(result.needsSupport).toBe(false);
  });

  it("完備率ちょうど 90% は該当しない（「90% 未満」）", () => {
    const result = judge({ completedTasks: 100, observationsRecorded: 90 });
    expect(result.completenessPercent).toBe(COMPLETENESS_THRESHOLD_PERCENT);
    expect(result.signals.lowCompleteness).toBe(false);
  });

  it("既定値ちょうど 70% は該当しない（「70% 超」）", () => {
    const result = judge({ observationsRecorded: 100, observationsUsedDefaults: 70 });
    expect(result.defaultRatePercent).toBe(70);
    expect(result.signals.highDefaultRate).toBe(false);
  });

  it("入力ちょうど 10 秒は該当しない（「10 秒未満」）", () => {
    const result = judge({ inputDurationMedianMs: 10_000 });
    expect(result.signals.fastInput).toBe(false);
  });
});

describe("judgeTenantQuality: 値が無い指標を悪い側に倒さない", () => {
  it("完了タスクが 0 の日は完備率が null（0% にしない）", () => {
    const result = judge({ completedTasks: 0, observationsRecorded: 0 });
    expect(result.completenessPercent).toBeNull();
    expect(result.signals.lowCompleteness).toBe(false);
  });

  it("記録が 0 件なら既定値のまま比率は null", () => {
    const result = judge({ observationsRecorded: 0, observationsUsedDefaults: 0 });
    expect(result.defaultRatePercent).toBeNull();
    expect(result.signals.highDefaultRate).toBe(false);
  });

  it("計測が無ければ入力時間は該当しない", () => {
    const result = judge({ inputDurationMedianMs: null });
    expect(result.signals.fastInput).toBe(false);
  });

  it("**稼働していない日を要支援にしない**（全部 0 / 計測なし）", () => {
    const result = judgeTenantQuality(
      {
        completedTasks: 0,
        observationsRecorded: 0,
        observationsUsedDefaults: 0,
        inputDurationMedianMs: null,
      },
      THRESHOLDS,
    );
    expect(result.signalCount).toBe(0);
    expect(result.needsSupport).toBe(false);
  });
});

describe("judgeTenantQuality: 閾値を引数から読む（ベタ書きしない）", () => {
  it("既定値の閾値を 95% に上げると該当しなくなる", () => {
    const counts = { ...HEALTHY, observationsRecorded: 100, observationsUsedDefaults: 91 };
    expect(judgeTenantQuality(counts, THRESHOLDS).signals.highDefaultRate).toBe(true);
    expect(
      judgeTenantQuality(counts, { ...THRESHOLDS, defaultRateThresholdPercent: 95 }).signals
        .highDefaultRate,
    ).toBe(false);
  });

  it("入力の基準を 30 秒へ上げると 19 秒が該当になる", () => {
    expect(judge().signals.fastInput).toBe(false);
    expect(
      judgeTenantQuality(HEALTHY, { ...THRESHOLDS, inputDurationFloorSeconds: 30 }).signals
        .fastInput,
    ).toBe(true);
  });
});

describe("judgeTenantQuality: 割合は整数（浮動小数点を持ち回らない）", () => {
  it("小数点以下を切り捨てる（2/3 → 66）", () => {
    const result = judge({ completedTasks: 3, observationsRecorded: 2 });
    expect(result.completenessPercent).toBe(66);
    expect(Number.isInteger(result.completenessPercent)).toBe(true);
  });

  it("記録が分母を超えても壊れない（100% 超をそのまま返す）", () => {
    // 締めのあとに記録が届いた日。**丸めて隠さない。**
    const result = judge({ completedTasks: 10, observationsRecorded: 11 });
    expect(result.completenessPercent).toBe(110);
    expect(result.signals.lowCompleteness).toBe(false);
  });
});

describe("medianDurationMs", () => {
  it("空なら null", () => {
    expect(medianDurationMs([])).toBeNull();
  });

  it("奇数個は中央の値", () => {
    expect(medianDurationMs([5_000, 1_000, 3_000])).toBe(3_000);
  });

  it("偶数個は中間 2 つの平均を切り捨てる", () => {
    expect(medianDurationMs([1_000, 2_000, 3_000, 4_001])).toBe(2_500);
  });

  it("1 件ならその値", () => {
    expect(medianDurationMs([12_345])).toBe(12_345);
  });

  it("**引数の配列を並べ替えない**", () => {
    const input = [5_000, 1_000, 3_000];
    medianDurationMs(input);
    expect(input).toEqual([5_000, 1_000, 3_000]);
  });
});
