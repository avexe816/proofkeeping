/**
 * 対象月 → 業務日の範囲のテスト（PK-SPEC-P3 §6.3）。
 *
 * task: docs/tasks/P3-12.md
 *
 * `collectDataQuality()` は D1 を読むのでここでは扱わない。率と平均の
 * 検査は `packages/engine/src/dataQuality.spec.ts`（純粋関数）。
 */

import { describe, expect, it } from "vitest";

import { monthRangeOf } from "./dataQuality.js";

describe("monthRangeOf", () => {
  it("31 日の月", () => {
    expect(monthRangeOf("2026-08")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("30 日の月", () => {
    expect(monthRangeOf("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("平年の 2 月", () => {
    expect(monthRangeOf("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("うるう年の 2 月", () => {
    expect(monthRangeOf("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("12 月は年をまたいで計算する", () => {
    expect(monthRangeOf("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("形が違えば null", () => {
    expect(monthRangeOf("2026-8")).toBeNull();
    expect(monthRangeOf("2026")).toBeNull();
    expect(monthRangeOf("")).toBeNull();
    expect(monthRangeOf("2026-08-01")).toBeNull();
  });

  it("実在しない月は null", () => {
    expect(monthRangeOf("2026-13")).toBeNull();
    expect(monthRangeOf("2026-00")).toBeNull();
  });
});
