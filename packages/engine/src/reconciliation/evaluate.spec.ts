/**
 * 照合の入口とレジストリ（P4-03 / PK-SPEC-P4 §9・§10.1）。
 *
 * ルール: .claude/rules/testing.md §3
 *
 * **ルールの実体はまだ無い**（R001 / R006 は P4-04）。ここで固定するのは
 * 骨格の性質だけ ——「登録するだけで動く」「抑制はルールを呼ばない」
 * 「調整が必ず掛かる」「同じ入力から同じ出力」。
 */

import { describe, expect, it } from "vitest";

import { SINGLE_SIGNAL_CONFIDENCE_CAP, USED_DEFAULTS_PENALTY } from "./confidence.js";
import { evaluate } from "./evaluate.js";
import { RULES, findRule, implementedRuleCodes } from "./rules/registry.js";
import type { FindingDraft, ObservationFact, Rule, RuleContext } from "./types.js";

const NOW = new Date("2026-09-10T02:00:00+09:00");

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

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    now: NOW,
    businessDate: "2026-09-09",
    property: {
      id: "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      occupancyLinked: true,
      daysSinceOperationStart: 400,
    },
    room: {
      id: "o7k2m9__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      number: "302",
      roomTypeId: "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      saleStatus: "ON_SALE",
    },
    occupancy: {
      isOccupied: false,
      guestCount: 0,
      reservationRef: null,
      checkInAt: null,
      checkOutAt: null,
      isStayover: false,
      nightsTotal: null,
      nightIndex: null,
      isComplimentary: false,
      isHouseUse: false,
    },
    observation: observation(),
    task: null,
    signals: [],
    accessLogs: [],
    baselines: [],
    previousObservation: null,
    thresholds: {},
    ...overrides,
  };
}

/** 必ず 1 件返すテスト用ルール。**レジストリには載せない。** */
function alwaysRule(overrides: Partial<Rule> = {}, draft: Partial<FindingDraft> = {}): Rule {
  return {
    code: "TEST_A",
    version: "1.0",
    title: "テスト用",
    requires: ["occupancy", "observation"],
    evaluate: (): FindingDraft => ({
      ruleCode: "TEST_A",
      severity: "HIGH",
      confidence: 90,
      title: "テスト",
      summary: "",
      evidence: {},
      matchedSignals: ["BEDS_USED", "TRASH_PRESENT"],
      ...draft,
    }),
    ...overrides,
  };
}

/** 何も返さないテスト用ルール。 */
const NEVER_RULE: Rule = {
  code: "TEST_B",
  version: "1.0",
  title: "テスト用",
  requires: ["observation"],
  evaluate: () => null,
};

describe("registry", () => {
  it("P4-03 の時点で 1 つも登録していない（R001 / R006 は P4-04）", () => {
    expect(RULES).toEqual([]);
    expect(implementedRuleCodes()).toEqual([]);
  });

  it("未実装のコードは undefined", () => {
    expect(findRule("R001")).toBeUndefined();
    expect(findRule("NOPE")).toBeUndefined();
  });
});

describe("evaluate — ルールを呼ぶ（正例）", () => {
  it("該当すれば差異を 1 件返す", () => {
    const result = evaluate(context(), {}, [alwaysRule()]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleCode).toBe("TEST_A");
    expect(result.rulesEvaluated).toBe(1);
    expect(result.suppressed).toEqual([]);
  });

  it("該当しなければ差異を返さないが、評価はした数に入る", () => {
    const result = evaluate(context(), {}, [NEVER_RULE]);
    expect(result.findings).toEqual([]);
    expect(result.rulesEvaluated).toBe(1);
    expect(result.suppressed).toEqual([]);
  });

  it("複数のルールを登録した順に回す", () => {
    const first = alwaysRule({ code: "TEST_1" }, { ruleCode: "TEST_1" });
    const second = alwaysRule({ code: "TEST_2" }, { ruleCode: "TEST_2" });
    const result = evaluate(context(), {}, [first, second]);
    expect(result.findings.map((finding) => finding.ruleCode)).toEqual(["TEST_1", "TEST_2"]);
  });

  it("ルールの追加が登録だけで済む（骨格に分岐を持たない）", () => {
    const before = evaluate(context(), {}, []);
    const after = evaluate(context(), {}, [alwaysRule()]);
    expect(before.findings).toEqual([]);
    expect(after.findings).toHaveLength(1);
  });

  it("ルールが 0 件なら何も返さない", () => {
    const result = evaluate(context(), {}, []);
    expect(result).toEqual({ findings: [], suppressed: [], rulesEvaluated: 0 });
  });
});

describe("evaluate — 抑制（負例 / §4.1・§4.3）", () => {
  it("抑制したルールは評価しない", () => {
    let called = false;
    const rule: Rule = {
      ...alwaysRule(),
      evaluate: () => {
        called = true;
        return null;
      },
    };
    const result = evaluate(context({ room: { ...context().room, saleStatus: "MAINTENANCE" } }), {}, [
      rule,
    ]);

    expect(called).toBe(false);
    expect(result.rulesEvaluated).toBe(0);
  });

  it("抑制した件数と理由を残す（沈黙させない）", () => {
    const result = evaluate(context({ accessLogs: [{ purpose: "INSPECTION", enteredAt: 0, exitedAt: null }] }), {}, [
      alwaysRule(),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.suppressed).toEqual([{ ruleCode: "TEST_A", reason: "ACCESS_LOG_REGISTERED" }]);
  });

  it("設定で無効にしたルールを抑制する", () => {
    const result = evaluate(
      context(),
      { settings: { TEST_A: { isEnabled: false, severityOverride: null, thresholds: {} } } },
      [alwaysRule()],
    );
    expect(result.suppressed).toEqual([{ ruleCode: "TEST_A", reason: "RULE_DISABLED" }]);
  });

  it("系統が欠けたルールだけを抑え、他は動かす（§1.2）", () => {
    // 観察だけがある施設。A + B のルールは抑制、B だけのルールは動く。
    const needsBoth = alwaysRule({ code: "TEST_AB" }, { ruleCode: "TEST_AB" });
    const needsObservation = alwaysRule(
      { code: "TEST_B_ONLY", requires: ["observation"] },
      { ruleCode: "TEST_B_ONLY" },
    );
    const result = evaluate(context({ occupancy: null }), {}, [needsBoth, needsObservation]);

    expect(result.suppressed).toEqual([
      { ruleCode: "TEST_AB", reason: "SOURCE_UNAVAILABLE" },
    ]);
    expect(result.findings.map((finding) => finding.ruleCode)).toEqual(["TEST_B_ONLY"]);
  });

  it("稼働記録が無い施設でも完走する（§0.3 / §10.1）", () => {
    const result = evaluate(context({ occupancy: null, observation: null, signals: [] }), {}, [
      alwaysRule(),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
  });

  it("観察が無い客室でエラーにならない（§10.1）", () => {
    expect(() => evaluate(context({ observation: null }), {}, [alwaysRule()])).not.toThrow();
  });
});

describe("evaluate — 調整（§1.3 / §4.2）", () => {
  it("単一シグナルの差異は 80 以上にならない", () => {
    const result = evaluate(context(), {}, [
      alwaysRule({}, { confidence: 95, matchedSignals: ["BEDS_USED"] }),
    ]);
    expect(result.findings[0]?.confidence).toBe(SINGLE_SIGNAL_CONFIDENCE_CAP);
  });

  it("既定値のまま確定した観察に基づく差異は 20 低い", () => {
    const base = evaluate(context(), {}, [alwaysRule()]);
    const withDefaults = evaluate(context({ observation: observation({ usedDefaults: true }) }), {}, [
      alwaysRule(),
    ]);
    expect((base.findings[0]?.confidence ?? 0) - (withDefaults.findings[0]?.confidence ?? 0)).toBe(
      -USED_DEFAULTS_PENALTY,
    );
  });

  it("誤検知が 3 回以上なら重要度を 1 段階下げる", () => {
    const result = evaluate(context(), { falsePositiveCounts: { TEST_A: 3 } }, [alwaysRule()]);
    expect(result.findings[0]?.severity).toBe("MEDIUM");
  });

  it("施設ごとの重要度の上書きが効く", () => {
    const result = evaluate(
      context(),
      { settings: { TEST_A: { isEnabled: true, severityOverride: "LOW", thresholds: {} } } },
      [alwaysRule()],
    );
    expect(result.findings[0]?.severity).toBe("LOW");
  });

  it("根拠に使ったベースラインのサンプル数で確信度が下がる", () => {
    const rule = alwaysRule({}, { matchedSignals: ["BATH_TOWEL_OVER", "FACE_TOWEL_OVER"] });
    const result = evaluate(
      context({
        baselines: [
          { itemCode: "BATH_TOWEL", sampleSize: 25, medianQty: 2, p90Qty: 3, isReliable: true },
          { itemCode: "FACE_TOWEL", sampleSize: 80, medianQty: 2, p90Qty: 3, isReliable: true },
        ],
      }),
      {},
      [rule],
    );
    // **心もとないほうに合わせる**（25 が範囲内なので −10）。
    expect(result.findings[0]?.confidence).toBe(80);
  });
});

describe("evaluate — 閾値とルール設定", () => {
  it("ルールごとの閾値を渡す", () => {
    let seen: Readonly<Record<string, number>> | null = null;
    const rule: Rule = {
      ...alwaysRule(),
      evaluate: (ruleContext) => {
        seen = ruleContext.thresholds;
        return null;
      },
    };
    evaluate(
      context(),
      { settings: { TEST_A: { isEnabled: true, severityOverride: null, thresholds: { over: 3 } } } },
      [rule],
    );
    expect(seen).toEqual({ over: 3 });
  });

  it("設定が無ければ空の閾値を渡す", () => {
    let seen: Readonly<Record<string, number>> | null = null;
    const rule: Rule = {
      ...alwaysRule(),
      evaluate: (ruleContext) => {
        seen = ruleContext.thresholds;
        return null;
      },
    };
    evaluate(context(), {}, [rule]);
    expect(seen).toEqual({});
  });

  it("渡された現在時刻をそのまま使う（Date.now を呼ばない）", () => {
    let seen: Date | null = null;
    const rule: Rule = {
      ...alwaysRule(),
      evaluate: (ruleContext) => {
        seen = ruleContext.now;
        return null;
      },
    };
    evaluate(context(), {}, [rule]);
    expect(seen).toBe(NOW);
  });
});

describe("evaluate — 決定性（§10.1・§10.2）", () => {
  it("同じ入力を 3 回評価しても同じ結果", () => {
    const rules = [alwaysRule(), NEVER_RULE];
    const first = evaluate(context(), {}, rules);
    const second = evaluate(context(), {}, rules);
    const third = evaluate(context(), {}, rules);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("入力の文脈を書き換えない", () => {
    const input = context();
    const snapshot = structuredClone(input);
    evaluate(input, {}, [alwaysRule()]);
    expect({ ...input, now: input.now.getTime() }).toEqual({
      ...snapshot,
      now: snapshot.now.getTime(),
    });
  });
});
