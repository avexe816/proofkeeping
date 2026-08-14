/**
 * R003 — 人数とリネン消費の相違（PK-SPEC-P4 §3.4）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - `p90 + 1` を超えて初めて差異になる（余裕を持たせてある）
 *   - **`isReliable = false` のベースラインを使わない**（P4-11 の完了条件）
 *   - 連泊では加点しない（§3.4 MUST。前日分の未回収が混ざりうる）
 *   - バスタオル以外だけの超過は差異にしない（§3.4 が名指ししている品目）
 */

import { describe, expect, it } from "vitest";

import type { BaselineFact } from "../types.js";

import {
  R003,
  R003_BASE_CONFIDENCE,
  R003_LARGE_EXCESS_BONUS,
  R003_MULTI_ITEM_BONUS,
  R003_NOT_STAYOVER_BONUS,
  excessItemsOf,
  linenUsageOf,
} from "./R003.js";
import { observationFact, occupancyFact, ruleContext } from "./testContext.js";

/** バスタオルの基準値。**既定は p90 = 2**（2 名の部屋で 2 枚が上位 10%）。 */
function baseline(overrides: Partial<BaselineFact> = {}): BaselineFact {
  return { itemCode: "BATH_TOWEL", sampleSize: 60, medianQty: 2, p90Qty: 2, isReliable: true, ...overrides };
}

describe("R003 — 正例（差異になる）", () => {
  it("バスタオルが p90 + 1 を超えていれば差異", () => {
    const finding = R003.evaluate(
      ruleContext({
        observation: observationFact({ bathTowelUsed: 4 }),
        baselines: [baseline()],
      }),
    );
    expect(finding?.ruleCode).toBe("R003");
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("連泊でなければ +10 される", () => {
    const finding = R003.evaluate(
      ruleContext({
        occupancy: occupancyFact({ isStayover: false }),
        observation: observationFact({ bathTowelUsed: 4 }),
        baselines: [baseline()],
      }),
    );
    // 超過幅 2 は p90(2) × 1.5 = 3 に届かないので大幅加点は無い。
    expect(finding?.confidence).toBe(R003_BASE_CONFIDENCE + R003_NOT_STAYOVER_BONUS);
  });

  it("超過幅が p90 の 1.5 倍以上なら +25", () => {
    const finding = R003.evaluate(
      ruleContext({
        observation: observationFact({ bathTowelUsed: 6 }),
        baselines: [baseline()],
      }),
    );
    expect(finding?.confidence).toBe(
      R003_BASE_CONFIDENCE + R003_LARGE_EXCESS_BONUS + R003_NOT_STAYOVER_BONUS,
    );
  });

  it("複数品目が同時に超過していれば +20", () => {
    const finding = R003.evaluate(
      ruleContext({
        observation: observationFact({ bathTowelUsed: 4, faceTowelUsed: 5 }),
        baselines: [baseline(), baseline({ itemCode: "FACE_TOWEL", p90Qty: 2 })],
      }),
    );
    expect(finding?.confidence).toBe(
      R003_BASE_CONFIDENCE + R003_MULTI_ITEM_BONUS + R003_NOT_STAYOVER_BONUS,
    );
    expect(finding?.matchedSignals).toEqual(["EXCESS_BATH_TOWEL", "EXCESS_FACE_TOWEL"]);
  });

  it("連泊では加点しない（§3.4 MUST）", () => {
    const stayover = R003.evaluate(
      ruleContext({
        occupancy: occupancyFact({ isStayover: true }),
        observation: observationFact({ bathTowelUsed: 4 }),
        baselines: [baseline()],
      }),
    );
    expect(stayover?.confidence).toBe(R003_BASE_CONFIDENCE);
  });

  it("根拠として基準値と実測を残す", () => {
    const finding = R003.evaluate(
      ruleContext({
        observation: observationFact({ bathTowelUsed: 4 }),
        baselines: [baseline()],
      }),
    );
    expect(finding?.evidence["baseline"]).toEqual([
      { itemCode: "BATH_TOWEL", used: 4, p90Qty: 2 },
    ]);
  });
});

describe("R003 — 負例（差異にしない）", () => {
  it("`isReliable = false` の基準値は使わない（P4-11 の完了条件）", () => {
    expect(
      R003.evaluate(
        ruleContext({
          observation: observationFact({ bathTowelUsed: 9 }),
          baselines: [baseline({ isReliable: false })],
        }),
      ),
    ).toBeNull();
  });

  it("p90 + 1 ちょうどでは差異にしない（余裕の内側）", () => {
    expect(
      R003.evaluate(
        ruleContext({
          observation: observationFact({ bathTowelUsed: 3 }),
          baselines: [baseline()],
        }),
      ),
    ).toBeNull();
  });

  it("基準値が無ければ差異にしない", () => {
    expect(
      R003.evaluate(
        ruleContext({ observation: observationFact({ bathTowelUsed: 9 }), baselines: [] }),
      ),
    ).toBeNull();
  });

  it("稼働記録が空室なら差異にしない（R001 の担当）", () => {
    expect(
      R003.evaluate(
        ruleContext({
          occupancy: occupancyFact({ isOccupied: false }),
          observation: observationFact({ bathTowelUsed: 9 }),
          baselines: [baseline()],
        }),
      ),
    ).toBeNull();
  });

  it("記録しないことを選んだ日は差異にしない", () => {
    expect(
      R003.evaluate(
        ruleContext({
          observation: observationFact({ skipped: true, bathTowelUsed: 9 }),
          baselines: [baseline()],
        }),
      ),
    ).toBeNull();
  });

  it("バスタオル以外だけの超過は差異にしない", () => {
    expect(
      R003.evaluate(
        ruleContext({
          observation: observationFact({ bathTowelUsed: 2, faceTowelUsed: 9 }),
          baselines: [baseline(), baseline({ itemCode: "FACE_TOWEL", p90Qty: 2 })],
        }),
      ),
    ).toBeNull();
  });

  it("観察が無ければ差異にしない", () => {
    expect(R003.evaluate(ruleContext({ observation: null, baselines: [baseline()] }))).toBeNull();
  });
});

describe("linenUsageOf / excessItemsOf", () => {
  it("アメニティを混ぜない（R008 の担当）", () => {
    expect(Object.keys(linenUsageOf(observationFact()))).toEqual([
      "BATH_TOWEL",
      "FACE_TOWEL",
      "HAND_TOWEL",
      "BATH_MAT",
    ]);
  });

  it("並びは宣言順で固定（§10.1 の決定性）", () => {
    const excesses = excessItemsOf(
      { BATH_TOWEL: 9, FACE_TOWEL: 9, HAND_TOWEL: 9, BATH_MAT: 9 },
      [
        baseline({ itemCode: "BATH_MAT", p90Qty: 1 }),
        baseline({ itemCode: "HAND_TOWEL", p90Qty: 1 }),
        baseline({ itemCode: "FACE_TOWEL", p90Qty: 1 }),
        baseline({ itemCode: "BATH_TOWEL", p90Qty: 1 }),
      ],
    );
    expect(excesses.map((row) => row.itemCode)).toEqual([
      "BATH_TOWEL",
      "FACE_TOWEL",
      "HAND_TOWEL",
      "BATH_MAT",
    ]);
  });
});
