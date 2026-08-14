/**
 * R004 — 退室日と清掃日の相違（PK-SPEC-P4 §3.5）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 翌日ちょうどは通常の運用（差異にしない）
 *   - **`occupancyBetweenCheckOutAndToday` が `null` なら差異にしない**
 *     （§1.2「分からないものを『無かった』に倒さない」）
 *   - 空いた日数で確信度が上がる
 */

import { describe, expect, it } from "vitest";

import {
  R004,
  R004_BASE_CONFIDENCE,
  R004_CONFIDENCE_PER_DAY,
  R004_MAX_CONFIDENCE,
  businessDateDiff,
} from "./R004.js";
import { occupancyFact, ruleContext } from "./testContext.js";

const CHECKED_OUT_AT = Date.parse("2026-09-05T11:00:00+09:00");

/** アウト清掃が完了したタスク。 */
function checkoutTask(overrides: Record<string, unknown> = {}) {
  return {
    taskType: "CHECKOUT",
    isCompleted: true,
    startedAt: null,
    completedAt: Date.parse("2026-09-09T13:00:00+09:00"),
    actualMinutes: 40,
    photoCount: 3,
    ...overrides,
  };
}

/** 退室が空いていて、その間に稼働が無かった文脈。 */
function delayed(overrides: Parameters<typeof ruleContext>[0] = {}) {
  return ruleContext({
    occupancy: occupancyFact({ isOccupied: false, checkOutAt: CHECKED_OUT_AT }),
    checkOutBusinessDate: "2026-09-05",
    occupancyBetweenCheckOutAndToday: false,
    task: checkoutTask(),
    ...overrides,
  });
}

describe("R004 — 正例（差異になる）", () => {
  it("退室から 4 日空いていれば差異", () => {
    const finding = R004.evaluate(delayed());
    expect(finding?.ruleCode).toBe("R004");
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("2 日空いた時点で差異になる（翌々日）", () => {
    const finding = R004.evaluate(
      delayed({ checkOutBusinessDate: "2026-09-07" }),
    );
    expect(finding).not.toBeNull();
  });

  it("空いた日数だけ確信度が上がる", () => {
    const two = R004.evaluate(delayed({ checkOutBusinessDate: "2026-09-07" }));
    const four = R004.evaluate(delayed({ checkOutBusinessDate: "2026-09-05" }));
    expect(two?.confidence).toBe(R004_BASE_CONFIDENCE + R004_CONFIDENCE_PER_DAY);
    expect(four?.confidence).toBeGreaterThan(two?.confidence ?? 0);
  });

  it("確信度に上限がある", () => {
    const finding = R004.evaluate(delayed({ checkOutBusinessDate: "2026-01-01" }));
    expect(finding?.confidence).toBe(R004_MAX_CONFIDENCE);
  });

  it("根拠に退室日・清掃日・空いた日数を残す", () => {
    const finding = R004.evaluate(delayed());
    expect(finding?.evidence["gapDays"]).toBe(4);
    expect(finding?.matchedSignals).toEqual(["CLEANING_DELAYED"]);
  });
});

describe("R004 — 負例（差異にしない）", () => {
  it("翌日ちょうどは通常の運用", () => {
    expect(R004.evaluate(delayed({ checkOutBusinessDate: "2026-09-08" }))).toBeNull();
  });

  it("同じ日の清掃は差異にしない", () => {
    expect(R004.evaluate(delayed({ checkOutBusinessDate: "2026-09-09" }))).toBeNull();
  });

  it("その間に稼働があったなら差異にしない", () => {
    expect(R004.evaluate(delayed({ occupancyBetweenCheckOutAndToday: true }))).toBeNull();
  });

  it("**分からない（null）なら差異にしない**（§1.2）", () => {
    expect(R004.evaluate(delayed({ occupancyBetweenCheckOutAndToday: null }))).toBeNull();
  });

  it("退室の記録が無ければ差異にしない", () => {
    expect(
      R004.evaluate(delayed({ occupancy: occupancyFact({ checkOutAt: null }) })),
    ).toBeNull();
  });

  it("アウト清掃でなければ差異にしない", () => {
    expect(R004.evaluate(delayed({ task: checkoutTask({ taskType: "STAY" }) }))).toBeNull();
  });

  it("清掃が完了していなければ差異にしない", () => {
    expect(R004.evaluate(delayed({ task: checkoutTask({ isCompleted: false }) }))).toBeNull();
  });

  it("清掃タスクが無ければ差異にしない", () => {
    expect(R004.evaluate(delayed({ task: null }))).toBeNull();
  });
});

describe("businessDateDiff", () => {
  it("日数を返す", () => {
    expect(businessDateDiff("2026-09-05", "2026-09-09")).toBe(4);
  });

  it("同じ日は 0", () => {
    expect(businessDateDiff("2026-09-09", "2026-09-09")).toBe(0);
  });

  it("逆順は負", () => {
    expect(businessDateDiff("2026-09-09", "2026-09-05")).toBe(-4);
  });

  it("月をまたいでも数えられる", () => {
    expect(businessDateDiff("2026-08-30", "2026-09-02")).toBe(3);
  });

  it("形が違えば null（0 を返さない）", () => {
    expect(businessDateDiff("2026-9-5", "2026-09-09")).toBeNull();
    expect(businessDateDiff("", "2026-09-09")).toBeNull();
  });
});
