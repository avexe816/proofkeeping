/**
 * 確信度と重要度の調整（P4-03 / PK-SPEC-P4 §1.3・§4.2）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を各 5 件以上）
 *
 * **単一シグナルの上限**（§1.3）と**既定値の観察で −20**（§10.4）は
 * 出荷判定に直接載っている。ここが緩むと、根拠の薄い差異が
 * 「ほぼ確実」として現場に出る。
 */

import { describe, expect, it } from "vitest";

import {
  FALSE_POSITIVE_DOWNGRADE_THRESHOLD,
  NEW_OPERATION_PENALTY,
  SINGLE_SIGNAL_CONFIDENCE_CAP,
  SMALL_SAMPLE_PENALTY,
  USED_DEFAULTS_PENALTY,
  adjustConfidence,
  applyAdjustments,
  capSingleSignal,
  clampConfidence,
  downgradeSeverity,
} from "./confidence.js";
import type { FindingDraft, ObservationFact, PropertyFact } from "./types.js";

const MATURE_PROPERTY: PropertyFact = {
  id: "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  occupancyLinked: true,
  daysSinceOperationStart: 400,
};

const NEW_PROPERTY: PropertyFact = { ...MATURE_PROPERTY, daysSinceOperationStart: 30 };

function observation(overrides: Partial<ObservationFact> = {}): ObservationFact {
  return {
    skipped: false,
    bedsUsed: 1,
    trashLevel: "NORMAL",
    bathTowelUsed: 2,
    faceTowelUsed: 2,
    handTowelUsed: 0,
    bathMatUsed: 1,
    slippersUsed: 0,
    cupsUsed: 0,
    extraFutonUsed: 0,
    amenitiesUsed: {},
    usedDefaults: false,
    ...overrides,
  };
}

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    ruleCode: "R001",
    severity: "HIGH",
    confidence: 80,
    title: "302 号室：稼働記録のない使用痕跡",
    summary: "",
    evidence: {},
    matchedSignals: ["BEDS_USED", "TRASH_PRESENT"],
    ...overrides,
  };
}

describe("clampConfidence", () => {
  it("範囲内はそのまま", () => {
    expect(clampConfidence(0)).toBe(0);
    expect(clampConfidence(55)).toBe(55);
    expect(clampConfidence(100)).toBe(100);
  });

  it("下限・上限で頭打ちにする", () => {
    expect(clampConfidence(-30)).toBe(0);
    expect(clampConfidence(140)).toBe(100);
  });

  it("小数を丸める", () => {
    expect(clampConfidence(55.4)).toBe(55);
    expect(clampConfidence(55.5)).toBe(56);
  });

  it("数でない値は 0（差異を高い確信度で出さない側へ倒す）", () => {
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("adjustConfidence — 下げる（正例）", () => {
  it("既定値のまま確定した観察で −20（§10.4）", () => {
    const value = adjustConfidence(80, {
      observation: observation({ usedDefaults: true }),
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
    });
    expect(value).toBe(80 + USED_DEFAULTS_PENALTY);
  });

  it("ベースラインのサンプル数が 20 なら −10", () => {
    const value = adjustConfidence(80, {
      observation: observation(),
      property: MATURE_PROPERTY,
      baselineSampleSize: 20,
    });
    expect(value).toBe(80 + SMALL_SAMPLE_PENALTY);
  });

  it("ベースラインのサンプル数が 40 なら −10（上端も範囲内）", () => {
    const value = adjustConfidence(80, {
      observation: observation(),
      property: MATURE_PROPERTY,
      baselineSampleSize: 40,
    });
    expect(value).toBe(80 + SMALL_SAMPLE_PENALTY);
  });

  it("運用開始から 60 日未満なら −10", () => {
    const value = adjustConfidence(80, {
      observation: observation(),
      property: NEW_PROPERTY,
      baselineSampleSize: null,
    });
    expect(value).toBe(80 + NEW_OPERATION_PENALTY);
  });

  it("条件が重なれば足し合わせる", () => {
    const value = adjustConfidence(80, {
      observation: observation({ usedDefaults: true }),
      property: NEW_PROPERTY,
      baselineSampleSize: 25,
    });
    expect(value).toBe(80 + USED_DEFAULTS_PENALTY + SMALL_SAMPLE_PENALTY + NEW_OPERATION_PENALTY);
  });

  it("下げた結果が 0 を下回らない", () => {
    const value = adjustConfidence(10, {
      observation: observation({ usedDefaults: true }),
      property: NEW_PROPERTY,
      baselineSampleSize: 25,
    });
    expect(value).toBe(0);
  });
});

describe("adjustConfidence — 下げない（負例）", () => {
  it("観察が無ければ既定値の調整は掛からない", () => {
    const value = adjustConfidence(80, {
      observation: null,
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
    });
    expect(value).toBe(80);
  });

  it("既定値を使っていない観察は下げない", () => {
    const value = adjustConfidence(80, {
      observation: observation({ usedDefaults: false }),
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
    });
    expect(value).toBe(80);
  });

  it("サンプル数が 19（範囲外）なら下げない", () => {
    // **19 以下は `isReliable = false` で、そもそも渡ってこない**
    // （PK-SPEC-P3 §2.4 MUST）。§4.2 の範囲は 20〜40。
    const value = adjustConfidence(80, {
      observation: observation(),
      property: MATURE_PROPERTY,
      baselineSampleSize: 19,
    });
    expect(value).toBe(80);
  });

  it("サンプル数が 41 なら下げない", () => {
    const value = adjustConfidence(80, {
      observation: observation(),
      property: MATURE_PROPERTY,
      baselineSampleSize: 41,
    });
    expect(value).toBe(80);
  });

  it("運用日数が分からなければ下げない（推測しない）", () => {
    const value = adjustConfidence(80, {
      observation: observation(),
      property: { ...MATURE_PROPERTY, daysSinceOperationStart: null },
      baselineSampleSize: null,
    });
    expect(value).toBe(80);
  });

  it("運用開始からちょうど 60 日なら下げない", () => {
    const value = adjustConfidence(80, {
      observation: observation(),
      property: { ...MATURE_PROPERTY, daysSinceOperationStart: 60 },
      baselineSampleSize: null,
    });
    expect(value).toBe(80);
  });
});

describe("capSingleSignal（§1.3 / P4 固有の絶対ルール）", () => {
  it("根拠 1 件は 80 以上にならない", () => {
    expect(capSingleSignal(95, 1)).toBe(SINGLE_SIGNAL_CONFIDENCE_CAP);
    expect(capSingleSignal(80, 1)).toBe(SINGLE_SIGNAL_CONFIDENCE_CAP);
  });

  it("根拠 0 件も単一扱い", () => {
    expect(capSingleSignal(95, 0)).toBe(SINGLE_SIGNAL_CONFIDENCE_CAP);
  });

  it("根拠 1 件でも上限より低ければそのまま", () => {
    expect(capSingleSignal(50, 1)).toBe(50);
  });

  it("根拠 2 件なら上限が掛からない", () => {
    expect(capSingleSignal(95, 2)).toBe(95);
  });

  it("根拠 3 件で 100 まで出せる", () => {
    expect(capSingleSignal(100, 3)).toBe(100);
  });
});

describe("downgradeSeverity", () => {
  it("1 段階ずつ下がる", () => {
    expect(downgradeSeverity("HIGH")).toBe("MEDIUM");
    expect(downgradeSeverity("MEDIUM")).toBe("LOW");
  });

  it("LOW はそれ以上下がらない", () => {
    expect(downgradeSeverity("LOW")).toBe("LOW");
  });
});

describe("applyAdjustments", () => {
  it("確信度の調整と単一シグナルの上限をまとめて掛ける", () => {
    const result = applyAdjustments(draft({ confidence: 95, matchedSignals: ["BEDS_USED"] }), {
      observation: observation({ usedDefaults: true }),
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
      falsePositiveCount: 0,
      severityOverride: null,
    });
    // 95 − 20 = 75。上限（79）より低いのでそのまま。
    expect(result.confidence).toBe(75);
  });

  it("誤検知が 3 回以上なら重要度を 1 段階下げる（§4.2）", () => {
    const result = applyAdjustments(draft({ severity: "HIGH" }), {
      observation: observation(),
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
      falsePositiveCount: FALSE_POSITIVE_DOWNGRADE_THRESHOLD,
      severityOverride: null,
    });
    expect(result.severity).toBe("MEDIUM");
  });

  it("誤検知が 2 回なら下げない", () => {
    const result = applyAdjustments(draft({ severity: "HIGH" }), {
      observation: observation(),
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
      falsePositiveCount: 2,
      severityOverride: null,
    });
    expect(result.severity).toBe("HIGH");
  });

  it("施設の上書きが先に効き、その上に引き下げが乗る", () => {
    const result = applyAdjustments(draft({ severity: "LOW" }), {
      observation: observation(),
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
      falsePositiveCount: 5,
      severityOverride: "HIGH",
    });
    expect(result.severity).toBe("MEDIUM");
  });

  it("元の下書きを書き換えない（純粋関数）", () => {
    const original = draft({ confidence: 95, severity: "HIGH" });
    applyAdjustments(original, {
      observation: observation({ usedDefaults: true }),
      property: MATURE_PROPERTY,
      baselineSampleSize: null,
      falsePositiveCount: 5,
      severityOverride: null,
    });
    expect(original.confidence).toBe(95);
    expect(original.severity).toBe("HIGH");
  });

  it("同じ入力から同じ出力（§10.1 の決定性）", () => {
    const inputs = {
      observation: observation({ usedDefaults: true }),
      property: NEW_PROPERTY,
      baselineSampleSize: 25,
      falsePositiveCount: 3,
      severityOverride: null,
    } as const;
    expect(applyAdjustments(draft(), inputs)).toEqual(applyAdjustments(draft(), inputs));
  });
});
