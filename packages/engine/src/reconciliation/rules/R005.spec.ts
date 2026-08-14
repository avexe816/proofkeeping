/**
 * R005 — 連泊記録と現場の相違（PK-SPEC-P4 §3.6）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **「2 日連続」を 1 日で名乗らない。** 前日の観察と前日の稼働記録の
 *     両方が要る
 *   - スキップした日を「痕跡なし」と読まない（PK-SPEC-P3 §1.3）
 *   - 根拠が 2 つあるので単一シグナルの上限（§1.3）に掛からない
 */

import { describe, expect, it } from "vitest";

import { R005, R005_BASE_CONFIDENCE, R005_LONG_STAY_BONUS, hasNoTrace } from "./R005.js";
import { observationFact, occupancyFact, ruleContext } from "./testContext.js";

/** 痕跡が無い観察（ベッド 0・ゴミなし）。 */
function noTrace() {
  return observationFact({ bedsUsed: 0, trashLevel: "NONE" });
}

/** 2 日続けて痕跡が無い連泊の文脈。 */
function twoQuietDays(overrides: Parameters<typeof ruleContext>[0] = {}) {
  return ruleContext({
    occupancy: occupancyFact({ isStayover: true, nightIndex: 2 }),
    observation: noTrace(),
    previousOccupancy: occupancyFact({ isStayover: true, nightIndex: 1 }),
    previousObservation: noTrace(),
    ...overrides,
  });
}

describe("R005 — 正例（差異になる）", () => {
  it("2 日続けて痕跡が無ければ差異", () => {
    const finding = R005.evaluate(twoQuietDays());
    expect(finding?.ruleCode).toBe("R005");
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("根拠を 2 つ持つ（単一シグナルの上限に掛からない）", () => {
    const finding = R005.evaluate(twoQuietDays());
    expect(finding?.matchedSignals).toEqual(["NO_TRACE_TODAY", "NO_TRACE_PREVIOUS_DAY"]);
  });

  it("3 泊目以降は確信度が上がる", () => {
    const third = R005.evaluate(
      twoQuietDays({ occupancy: occupancyFact({ isStayover: true, nightIndex: 3 }) }),
    );
    expect(third?.confidence).toBe(R005_BASE_CONFIDENCE + R005_LONG_STAY_BONUS);
  });

  it("2 泊目は基点のまま", () => {
    expect(R005.evaluate(twoQuietDays())?.confidence).toBe(R005_BASE_CONFIDENCE);
  });

  it("泊数が分からなくても差異になる", () => {
    const finding = R005.evaluate(
      twoQuietDays({ occupancy: occupancyFact({ isStayover: true, nightIndex: null }) }),
    );
    expect(finding?.confidence).toBe(R005_BASE_CONFIDENCE);
  });

  it("前日の記録を根拠に残す", () => {
    const finding = R005.evaluate(twoQuietDays());
    expect(finding?.evidence["previousObservation"]).toMatchObject({
      bedsUsed: 0,
      trashLevel: "NONE",
    });
  });
});

describe("R005 — 負例（差異にしない）", () => {
  it("連泊でなければ差異にしない", () => {
    expect(
      R005.evaluate(twoQuietDays({ occupancy: occupancyFact({ isStayover: false }) })),
    ).toBeNull();
  });

  it("当日に痕跡があれば差異にしない", () => {
    expect(
      R005.evaluate(twoQuietDays({ observation: observationFact({ bedsUsed: 1 }) })),
    ).toBeNull();
  });

  it("ゴミがあれば差異にしない", () => {
    expect(
      R005.evaluate(
        twoQuietDays({ observation: observationFact({ bedsUsed: 0, trashLevel: "LOW" }) }),
      ),
    ).toBeNull();
  });

  it("**前日の観察が無ければ差異にしない**（1 日では 2 日連続と言えない）", () => {
    expect(R005.evaluate(twoQuietDays({ previousObservation: null }))).toBeNull();
  });

  it("**前日の稼働記録が無ければ差異にしない**", () => {
    expect(R005.evaluate(twoQuietDays({ previousOccupancy: null }))).toBeNull();
  });

  it("前日が連泊でなければ差異にしない", () => {
    expect(
      R005.evaluate(
        twoQuietDays({ previousOccupancy: occupancyFact({ isStayover: false }) }),
      ),
    ).toBeNull();
  });

  it("前日に痕跡があれば差異にしない", () => {
    expect(
      R005.evaluate(twoQuietDays({ previousObservation: observationFact({ bedsUsed: 2 }) })),
    ).toBeNull();
  });

  it("記録しないことを選んだ日は「痕跡なし」ではない", () => {
    expect(
      R005.evaluate(twoQuietDays({ observation: observationFact({ skipped: true, bedsUsed: 0, trashLevel: "NONE" }) })),
    ).toBeNull();
  });
});

describe("hasNoTrace", () => {
  it("ベッド 0・ゴミなしだけが真", () => {
    expect(hasNoTrace(noTrace())).toBe(true);
    expect(hasNoTrace(observationFact({ bedsUsed: 1, trashLevel: "NONE" }))).toBe(false);
    expect(hasNoTrace(observationFact({ bedsUsed: 0, trashLevel: "HIGH" }))).toBe(false);
  });

  it("記録が無い・スキップは偽（0 と混ぜない）", () => {
    expect(hasNoTrace(null)).toBe(false);
    expect(hasNoTrace(observationFact({ skipped: true, bedsUsed: 0, trashLevel: "NONE" }))).toBe(
      false,
    );
  });
});
