/**
 * D1 のバインド変数上限と分割（`limits.ts`）。
 *
 * ルール: .claude/rules/testing.md §3
 *
 * ── なぜ「行数」ではなく「変数の数」で試すか ─────────────
 * 実際に落ちたのは `expandChecklist()` で、**60 行 × 11 列 = 660 変数**
 * だった。行数（60）だけを見ていると上限に収まっているように読める。
 * ここでは分割の結果が**必ず 100 変数以内**であることを直接確かめる。
 */

import { describe, expect, it } from "vitest";

import { D1_MAX_BOUND_PARAMS, chunkByParamBudget, chunkIdsForInArray } from "./limits.js";

/** 0..n-1 の並び。 */
function seq(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index);
}

describe("D1_MAX_BOUND_PARAMS", () => {
  it("100（SQLite の 999 ではない）", () => {
    // **この値を上げないこと。** D1 の制約で、こちらでは変えられない。
    expect(D1_MAX_BOUND_PARAMS).toBe(100);
  });
});

describe("chunkByParamBudget — 正例", () => {
  it("空の並びは空", () => {
    expect(chunkByParamBudget([], 10)).toEqual([]);
  });

  it("1 塊に収まるなら 1 塊", () => {
    expect(chunkByParamBudget(seq(5), 10)).toEqual([seq(5)]);
  });

  it("11 列なら 1 塊 9 件（9 × 11 = 99 ≤ 100）", () => {
    const chunks = chunkByParamBudget(seq(20), 11);
    expect(chunks[0]).toHaveLength(9);
    expect(chunks.map((chunk) => chunk.length)).toEqual([9, 9, 2]);
  });

  it("落ちた条件（60 件 × 11 列）でも各塊が 100 変数以内", () => {
    for (const chunk of chunkByParamBudget(seq(60), 11)) {
      expect(chunk.length * 11).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });

  it("元の順序を保つ（並べ替えない）", () => {
    expect(chunkByParamBudget(seq(20), 11).flat()).toEqual(seq(20));
  });

  it("1 件も落とさない", () => {
    expect(chunkByParamBudget(seq(137), 7).flat()).toHaveLength(137);
  });

  it("reserved を引いた予算で割る", () => {
    // 予算 100 - 20 = 80。1 件 10 変数なら 8 件ずつ。
    expect(chunkByParamBudget(seq(20), 10, 20).map((c) => c.length)).toEqual([8, 8, 4]);
  });

  it("reserved を含めても各塊が 100 変数以内", () => {
    const reserved = 28;
    for (const chunk of chunkByParamBudget(seq(200), 1, reserved)) {
      expect(chunk.length + reserved).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });

  it("1 件あたり 100 変数でも 1 件ずつ通る", () => {
    expect(chunkByParamBudget(seq(3), 100).map((c) => c.length)).toEqual([1, 1, 1]);
  });

  it("変数を使わない並びは 1 塊のまま", () => {
    expect(chunkByParamBudget(seq(500), 0)).toEqual([seq(500)]);
  });
});

describe("chunkByParamBudget — 負例", () => {
  it("1 件が上限を超える設計は例外（黙って 1 件ずつにしない）", () => {
    expect(() => chunkByParamBudget(seq(2), 101)).toThrow(RangeError);
  });

  it("reserved が大きすぎて 1 件も入らない場合も例外", () => {
    expect(() => chunkByParamBudget(seq(2), 10, 95)).toThrow(RangeError);
  });

  it("reserved が上限そのものなら例外", () => {
    expect(() => chunkByParamBudget(seq(1), 1, D1_MAX_BOUND_PARAMS)).toThrow(RangeError);
  });

  it("例外のメッセージは大文字のコードで始まる（ログへ素通しできる形）", () => {
    // `sanitizeErrorCode()` が `:` の左だけを残す（middleware/resourceGuard.ts）。
    expect(() => chunkByParamBudget(seq(1), 200)).toThrow(/^D1_PARAM_BUDGET_TOO_SMALL:/);
  });

  it("空の並びなら 1 件が超えていても例外にしない（何も送らないので）", () => {
    expect(chunkByParamBudget([], 500)).toEqual([]);
  });
});

describe("chunkIdsForInArray", () => {
  const ids = (n: number): string[] => seq(n).map((index) => `id_${String(index)}`);

  it("既定の予約（16）を引いた 84 件ずつ", () => {
    expect(chunkIdsForInArray(ids(200)).map((c) => c.length)).toEqual([84, 84, 32]);
  });

  it("100 室の盤面（W-03 / M-10）が分割される", () => {
    // これが 1 文だと `too many SQL variables` になる。
    expect(chunkIdsForInArray(ids(100)).length).toBeGreaterThan(1);
  });

  it("各塊は予約を足しても 100 変数以内", () => {
    for (const chunk of chunkIdsForInArray(ids(300))) {
      expect(chunk.length + 16).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    }
  });

  it("担当施設が多い組織では呼び出し側が実数を渡せる", () => {
    expect(chunkIdsForInArray(ids(100), 60).map((c) => c.length)).toEqual([40, 40, 20]);
  });

  it("1 件も落とさず順序も保つ", () => {
    expect(chunkIdsForInArray(ids(137)).flat()).toEqual(ids(137));
  });

  it("空なら空", () => {
    expect(chunkIdsForInArray([])).toEqual([]);
  });
});
