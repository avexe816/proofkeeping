/**
 * 税額の計算（PK-SPEC-P5 §3.3 / billing.md §4）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── いちばん大事なテスト ────────────────────────────────
 * **端数処理が税率ごとに 1 回だけ**（§2.5 MUST）。行ごとに丸めた場合と
 * 結果が変わることを、具体的な数字で固定する。
 */

import { describe, expect, it } from "vitest";

import {
  TAX_ROUNDING_MODES,
  applyRounding,
  calculateTax,
  lineAmount,
  type TaxableLine,
} from "./tax.js";

function line(overrides: Partial<TaxableLine> = {}): TaxableLine {
  return { amount: 1000, taxRate: 10, isReducedRate: false, ...overrides };
}

describe("applyRounding — 3 種の丸め（billing.md §4）", () => {
  it("FLOOR は切り捨て", () => {
    expect(applyRounding(100.9, "FLOOR")).toBe(100);
  });

  it("CEIL は切り上げ", () => {
    expect(applyRounding(100.1, "CEIL")).toBe(101);
  });

  it("ROUND は四捨五入", () => {
    expect(applyRounding(100.4, "ROUND")).toBe(100);
    expect(applyRounding(100.5, "ROUND")).toBe(101);
  });

  it("整数はそのまま", () => {
    for (const mode of TAX_ROUNDING_MODES) {
      expect(applyRounding(100, mode), mode).toBe(100);
    }
  });

  it("**負の値も同じ向きに丸める**（赤伝で 1 円ずれない / §5）", () => {
    // 絶対値で丸めてから符号を戻す。`Math.round(-100.5)` は -100 になるが、
    // ここでは -101（元の伝票の +101 と対称）。
    expect(applyRounding(-100.5, "ROUND")).toBe(-101);
    expect(applyRounding(-100.9, "FLOOR")).toBe(-100);
    expect(applyRounding(-100.1, "CEIL")).toBe(-101);
  });

  it("赤伝と元の伝票が打ち消し合う", () => {
    for (const mode of TAX_ROUNDING_MODES) {
      const original = applyRounding(12_345.67, mode);
      const credit = applyRounding(-12_345.67, mode);
      expect(original + credit, mode).toBe(0);
    }
  });
});

describe("lineAmount — 明細の金額（§3.3 の手順①）", () => {
  it("数量 × 単価", () => {
    expect(lineAmount(180, 3200)).toBe(576_000);
  });

  it("小数の数量は切り捨て", () => {
    expect(lineAmount(0.5, 3001)).toBe(1500);
  });

  it("0 は 0", () => {
    expect(lineAmount(0, 3000)).toBe(0);
    expect(lineAmount(10, 0)).toBe(0);
  });

  it("負の数量（赤伝）も扱える", () => {
    expect(lineAmount(-10, 3000)).toBe(-30_000);
  });

  it("壊れた入力は 0（例外にしない）", () => {
    expect(lineAmount(Number.NaN, 3000)).toBe(0);
    expect(lineAmount(10, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("**税を掛けない**（税は税率ごとに 1 回 / 手順③）", () => {
    expect(lineAmount(1, 1000)).toBe(1000);
  });
});

describe("calculateTax — 税率ごとに 1 回だけ端数処理（§2.5 MUST）", () => {
  it("**行ごとに丸めた場合と結果が違う**", () => {
    // 105 円が 3 行。10% なら 1 行あたり 10.5 円。
    //   行ごとに切り捨て → 10 × 3 = 30 円
    //   まとめて切り捨て → 315 × 10 / 100 = 31.5 → 31 円
    const totals = calculateTax([line({ amount: 105 }), line({ amount: 105 }), line({ amount: 105 })], "FLOOR");
    expect(totals.taxAmount).toBe(31);
    expect(totals.taxAmount).not.toBe(30);
  });

  it("税率ごとに区分する", () => {
    const totals = calculateTax(
      [line({ amount: 1000, taxRate: 10 }), line({ amount: 1000, taxRate: 8 })],
      "FLOOR",
    );
    expect(totals.summaries).toHaveLength(2);
    expect(totals.taxAmount).toBe(180);
  });

  it("**同じ 8% でも軽減税率かどうかで区分が分かれる**", () => {
    const totals = calculateTax(
      [
        line({ amount: 1000, taxRate: 8, isReducedRate: true }),
        line({ amount: 1000, taxRate: 8, isReducedRate: false }),
      ],
      "FLOOR",
    );
    expect(totals.summaries).toHaveLength(2);
  });

  it("税率の高い順に並ぶ（§8.1 の様式）", () => {
    const totals = calculateTax(
      [line({ amount: 1000, taxRate: 8 }), line({ amount: 1000, taxRate: 10 })],
      "FLOOR",
    );
    expect(totals.summaries.map((row) => row.taxRate)).toEqual([10, 8]);
  });

  it("合計が区分の合計と一致する", () => {
    const totals = calculateTax(
      [line({ amount: 1234, taxRate: 10 }), line({ amount: 5678, taxRate: 8 })],
      "FLOOR",
    );
    expect(totals.subtotalAmount).toBe(6912);
    expect(totals.totalAmount).toBe(totals.subtotalAmount + totals.taxAmount);
  });

  it("丸め方式が効く", () => {
    const lines = [line({ amount: 105 })];
    expect(calculateTax(lines, "FLOOR").taxAmount).toBe(10);
    expect(calculateTax(lines, "CEIL").taxAmount).toBe(11);
    expect(calculateTax(lines, "ROUND").taxAmount).toBe(11);
  });

  it("明細が無ければ全部 0", () => {
    const totals = calculateTax([], "FLOOR");
    expect(totals).toMatchObject({ subtotalAmount: 0, taxAmount: 0, totalAmount: 0 });
    expect(totals.summaries).toEqual([]);
  });

  it("赤伝（負の明細）も計算できる", () => {
    const totals = calculateTax([line({ amount: -1000 })], "FLOOR");
    expect(totals.subtotalAmount).toBe(-1000);
    expect(totals.taxAmount).toBe(-100);
    expect(totals.totalAmount).toBe(-1100);
  });

  it("**結果はすべて整数**（浮動小数点を残さない / billing.md §4）", () => {
    const totals = calculateTax(
      [line({ amount: 3333, taxRate: 10 }), line({ amount: 7777, taxRate: 8 })],
      "ROUND",
    );
    expect(Number.isInteger(totals.subtotalAmount)).toBe(true);
    expect(Number.isInteger(totals.taxAmount)).toBe(true);
    expect(Number.isInteger(totals.totalAmount)).toBe(true);
    for (const row of totals.summaries) {
      expect(Number.isInteger(row.taxAmount)).toBe(true);
    }
  });
});
