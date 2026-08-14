/**
 * 消費税の検査（PK-SPEC-P5 §3.3 / .claude/rules/billing.md §4）。
 *
 * task:  docs/tasks/P5-04.md
 * ルール: .claude/rules/testing.md §3（純粋関数は正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import { calcLineAmount, calcTaxAmount, summarizeTax, type TaxableLine } from "./tax.js";

describe("calcTaxAmount — FLOOR（切り捨て）", () => {
  it.each([
    [1_012_600, 10, 101_260],
    [576_000, 10, 57_600],
    [1_005, 10, 100],
    [1_009, 10, 100],
    [1_234, 8, 98],
    [1, 10, 0],
  ])("¥%i × %i%% → ¥%i", (subtotal, rate, expected) => {
    expect(calcTaxAmount(subtotal, rate, "FLOOR")).toBe(expected);
  });
});

describe("calcTaxAmount — CEIL（切り上げ）", () => {
  it.each([
    [1_005, 10, 101],
    [1_001, 10, 101],
    [1_000, 10, 100],
    [1_234, 8, 99],
    [1, 10, 1],
  ])("¥%i × %i%% → ¥%i", (subtotal, rate, expected) => {
    expect(calcTaxAmount(subtotal, rate, "CEIL")).toBe(expected);
  });
});

describe("calcTaxAmount — ROUND（四捨五入）", () => {
  it.each([
    [1_005, 10, 101],
    [1_004, 10, 100],
    [1_000, 10, 100],
    [1_234, 8, 99],
    [1_231, 8, 98],
  ])("¥%i × %i%% → ¥%i", (subtotal, rate, expected) => {
    expect(calcTaxAmount(subtotal, rate, "ROUND")).toBe(expected);
  });

  it("ちょうど 0.5 円は切り上げる", () => {
    // 505 × 10% = 50.5
    expect(calcTaxAmount(505, 10, "ROUND")).toBe(51);
  });
});

describe("calcTaxAmount — 赤伝（マイナス伝票 / §5）", () => {
  it.each([
    ["FLOOR", 1_009],
    ["FLOOR", 1_005],
    ["CEIL", 1_001],
    ["ROUND", 1_005],
    ["ROUND", 1_004],
  ] as const)("%s: 赤伝の税額は元伝票の符号違いにちょうど一致する（¥%i）", (mode, subtotal) => {
    expect(calcTaxAmount(-subtotal, 10, mode)).toBe(-calcTaxAmount(subtotal, 10, mode));
  });
});

describe("calcTaxAmount — 整数しか返さない（billing.md §4 MUST）", () => {
  it.each([
    [3_333, 10],
    [7, 8],
    [999_999, 10],
    [12_345, 8],
    [1, 8],
  ])("¥%i × %i%% の結果は整数", (subtotal, rate) => {
    for (const mode of ["FLOOR", "CEIL", "ROUND"] as const) {
      expect(Number.isInteger(calcTaxAmount(subtotal, rate, mode))).toBe(true);
    }
  });

  it("0 円は方式によらず 0 円", () => {
    for (const mode of ["FLOOR", "CEIL", "ROUND"] as const) {
      expect(calcTaxAmount(0, 10, mode)).toBe(0);
    }
  });
});

describe("summarizeTax — 税率ごとに 1 回だけ端数処理する（§2.5 MUST）", () => {
  const lines: TaxableLine[] = [
    { amount: 1_005, taxRate: 10, isReducedRate: false },
    { amount: 1_005, taxRate: 10, isReducedRate: false },
    { amount: 1_005, taxRate: 10, isReducedRate: false },
  ];

  it("明細ごとに丸めた合計と一致しない（合計してから 1 回丸める）", () => {
    const [summary] = summarizeTax(lines, "FLOOR");
    // 合計 3,015 × 10% = 301.5 → 301
    expect(summary?.subtotalAmount).toBe(3_015);
    expect(summary?.taxAmount).toBe(301);
    // 明細ごとに丸めていたら 100 × 3 = 300 になる。**その値ではない。**
    expect(summary?.taxAmount).not.toBe(300);
  });

  it("税込合計は 小計 + 税額", () => {
    const [summary] = summarizeTax(lines, "FLOOR");
    expect(summary?.totalAmount).toBe(3_316);
  });

  it("税率が違えば別の行になる", () => {
    const mixed: TaxableLine[] = [
      { amount: 10_000, taxRate: 10, isReducedRate: false },
      { amount: 5_000, taxRate: 8, isReducedRate: true },
    ];
    const summaries = summarizeTax(mixed, "FLOOR");
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.taxRate)).toEqual([10, 8]);
    expect(summaries.map((s) => s.taxAmount)).toEqual([1_000, 400]);
  });

  it("同じ税率でも軽減税率の別で行が分かれる（§2.5 の uq_tax_sum）", () => {
    const mixed: TaxableLine[] = [
      { amount: 1_000, taxRate: 8, isReducedRate: false },
      { amount: 2_000, taxRate: 8, isReducedRate: true },
    ];
    const summaries = summarizeTax(mixed, "FLOOR");
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.isReducedRate)).toEqual([false, true]);
  });

  it("明細が空なら行も出ない", () => {
    expect(summarizeTax([], "FLOOR")).toEqual([]);
  });

  it("並び順は税率の高い順（PDF §8.1 の並びと揃える）", () => {
    const mixed: TaxableLine[] = [
      { amount: 100, taxRate: 8, isReducedRate: true },
      { amount: 100, taxRate: 10, isReducedRate: false },
    ];
    expect(summarizeTax(mixed, "FLOOR").map((s) => s.taxRate)).toEqual([10, 8]);
  });

  it("入力の並び順を変えても結果が変わらない（冪等 / testing.md §4）", () => {
    const mixed: TaxableLine[] = [
      { amount: 300, taxRate: 10, isReducedRate: false },
      { amount: 100, taxRate: 8, isReducedRate: true },
      { amount: 200, taxRate: 10, isReducedRate: false },
    ];
    expect(summarizeTax(mixed, "ROUND")).toEqual(summarizeTax([...mixed].reverse(), "ROUND"));
  });
});

describe("calcLineAmount — amount = quantity × unitPrice（§3.3 の手順 1）", () => {
  it.each([
    [180, 3_200, 576_000],
    [95, 3_800, 361_000],
    [42, 1_800, 75_600],
    [1, 3_200, 3_200],
    [0, 3_200, 0],
  ])("%i × ¥%i → ¥%i", (quantity, unitPrice, expected) => {
    expect(calcLineAmount(quantity, unitPrice, "FLOOR")).toBe(expected);
  });

  it("整数の数量では端数処理方式が結果に効かない", () => {
    for (const mode of ["FLOOR", "CEIL", "ROUND"] as const) {
      expect(calcLineAmount(7, 3_333, mode)).toBe(23_331);
    }
  });

  it.each([
    ["FLOOR", 0.5, 3_333, 1_666],
    ["CEIL", 0.5, 3_333, 1_667],
    ["ROUND", 0.5, 3_333, 1_667],
    ["FLOOR", 1.5, 1_001, 1_501],
    ["CEIL", 1.5, 1_001, 1_502],
  ] as const)("%s: %f × ¥%i → ¥%i", (mode, quantity, unitPrice, expected) => {
    expect(calcLineAmount(quantity, unitPrice, mode)).toBe(expected);
  });

  it("端数のある数量でも結果は整数（円未満は存在しない）", () => {
    for (const mode of ["FLOOR", "CEIL", "ROUND"] as const) {
      expect(Number.isInteger(calcLineAmount(0.25, 1_111, mode))).toBe(true);
    }
  });

  it("赤伝（負の数量）でも符号が割れない", () => {
    expect(calcLineAmount(-0.5, 3_333, "FLOOR")).toBe(-1_666);
    expect(calcLineAmount(-0.5, 3_333, "CEIL")).toBe(-1_667);
  });
});
