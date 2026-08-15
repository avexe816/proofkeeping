/**
 * 負荷試験の目標値と合否（P7-12 / PK-SPEC-P7 §4.1・§4.2）。
 *
 * ── ここが守っているもの ────────────────────────────────
 * **「測っていない」を「合格」と混ぜない。** 負荷試験の報告は
 * GA 判定（P7-17）の材料になる。サンプルが 0 件でも、エラーが出ていても
 * 「速かった」と読める報告を作らせない。
 *
 * 実際の計測は検証環境が要る（**人間が実施**）。ここが押さえるのは
 * 目標値の値と、合否の決め方。
 */

import { describe, expect, it } from "vitest";

import {
  CONCURRENCY_TARGET,
  PERF_TARGETS,
  SCENARIOS,
  SCENARIO_IDS,
  allScenariosPass,
  evaluateScenario,
  percentile,
  summarize,
  type ScenarioId,
  type ScenarioVerdict,
} from "../../scripts/loadTest/scenarios.ts";

describe("§4.1 の目標値", () => {
  it("仕様の表そのまま", () => {
    expect(PERF_TARGETS).toEqual({
      apiReadP95Ms: 300,
      apiWriteP95Ms: 500,
      mobileFirstPaintMs: 2000,
      propertyBoardMs: 800,
      reconciliationBatchMs: 600_000,
      dailyReportPdfMs: 30_000,
      invoicePdfMs: 15_000,
    });
  });

  it("同時接続は 1 施設 30 名 × 100 施設", () => {
    expect(CONCURRENCY_TARGET).toEqual({ propertiesPerOrg: 100, staffPerProperty: 30 });
  });
});

describe("§4.2 の 4 シナリオ", () => {
  it("A / B / C / D の 4 つ", () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([...SCENARIO_IDS]);
  });

  it("A は仕様の同時接続の目標値そのもの（100 × 30）", () => {
    const a = SCENARIOS.find((scenario) => scenario.id === "A");
    expect(a?.concurrency).toBe(3000);
  });

  it("B は 3,000 タスク同時完了", () => {
    expect(SCENARIOS.find((scenario) => scenario.id === "B")?.concurrency).toBe(3000);
  });

  it("C は 500 施設", () => {
    expect(SCENARIOS.find((scenario) => scenario.id === "C")?.concurrency).toBe(500);
  });

  it("D は 200 通", () => {
    expect(SCENARIOS.find((scenario) => scenario.id === "D")?.concurrency).toBe(200);
  });

  it("**書き込みのシナリオを読み取りの目標値で見ない**", () => {
    // B（完了）は書き込み。300ms で見ると通らないし、通ってもおかしい。
    expect(SCENARIOS.find((scenario) => scenario.id === "B")?.metric).toBe("apiWriteP95Ms");
    expect(SCENARIOS.find((scenario) => scenario.id === "A")?.metric).toBe("apiReadP95Ms");
  });

  it("全シナリオが叩く経路を持つ", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.paths.length, scenario.id).toBeGreaterThan(0);
    }
  });
});

describe("percentile", () => {
  it("**線形補間しない**（実測値だけを返す）", () => {
    const samples = [10, 20, 30, 40];
    expect(samples).toContain(percentile(samples, 0.95));
  });

  it("p50 / p95 / p99", () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBe(95);
    expect(percentile(samples, 0.99)).toBe(99);
  });

  it("空なら 0", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});

/** シナリオ A。**目標は読み取りの 300ms。** */
const SCENARIO_A = SCENARIOS.find((scenario) => scenario.id === "A") ?? SCENARIOS[0];
if (SCENARIO_A === undefined) throw new Error("SCENARIOS is empty");

describe("evaluateScenario", () => {
  it("目標値を下回れば合格", () => {
    const result = summarize("A", [100, 150, 200], 0);
    expect(evaluateScenario(SCENARIO_A, result)).toEqual({ kind: "PASS", targetMs: 300 });
  });

  it("**目標値ちょうどは不合格**（仕様は `< 300ms`）", () => {
    const result = summarize("A", [300], 0);
    expect(evaluateScenario(SCENARIO_A, result)).toEqual({
      kind: "FAIL",
      targetMs: 300,
      reason: "OVER_TARGET",
    });
  });

  it("**エラーが 1 件でもあれば不合格**（速くても）", () => {
    // 落ちた要求は速く返る。分位だけ見ると「エラーが増えるほど速い」。
    const result = summarize("A", [10, 10, 10], 1);
    expect(evaluateScenario(SCENARIO_A, result)).toEqual({
      kind: "FAIL",
      targetMs: 300,
      reason: "ERRORS",
    });
  });

  it("**サンプルが 0 件なら不合格**（「測っていない」を「合格」にしない）", () => {
    const result = summarize("A", [], 0);
    expect(evaluateScenario(SCENARIO_A, result)).toEqual({
      kind: "FAIL",
      targetMs: 300,
      reason: "NO_SAMPLES",
    });
  });
});

describe("allScenariosPass（§4.2 MUST）", () => {
  function verdicts(passing: readonly ScenarioId[]): Map<ScenarioId, ScenarioVerdict> {
    const map = new Map<ScenarioId, ScenarioVerdict>();
    for (const id of passing) map.set(id, { kind: "PASS", targetMs: 300 });
    return map;
  }

  it("4 つすべて合格なら真", () => {
    expect(allScenariosPass(verdicts(["A", "B", "C", "D"]))).toBe(true);
  });

  it("**1 つでも欠ければ偽**（未計測を合格に数えない）", () => {
    expect(allScenariosPass(verdicts(["A", "B", "C"]))).toBe(false);
    expect(allScenariosPass(verdicts([]))).toBe(false);
  });

  it("不合格が混ざれば偽", () => {
    const map = verdicts(["A", "B", "C"]);
    map.set("D", { kind: "FAIL", targetMs: 15_000, reason: "OVER_TARGET" });
    expect(allScenariosPass(map)).toBe(false);
  });
});
