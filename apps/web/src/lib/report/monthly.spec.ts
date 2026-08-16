/**
 * 月次レポートの組み立ての検査（純粋な部分だけ）。
 *
 * 集計そのものの検査は `packages/engine/src/monthlyReport.spec.ts`。
 * ここで見るのは月の遷移だけ（DB を触る部分は repositories.spec と
 * tenant-isolation が見る）。
 */

import { describe, expect, it } from "vitest";

import { previousMonthOf } from "./monthly.js";

describe("previousMonthOf", () => {
  // 正例
  it("月の途中は 1 つ戻る", () => {
    expect(previousMonthOf("2026-08")).toBe("2026-07");
  });
  it("2 桁の月から 1 桁の月へ", () => {
    expect(previousMonthOf("2026-10")).toBe("2026-09");
  });
  it("年をまたぐ", () => {
    expect(previousMonthOf("2026-01")).toBe("2025-12");
  });
  it("2 月へ戻る（日数の少ない月でも月単位なので影響しない）", () => {
    expect(previousMonthOf("2026-03")).toBe("2026-02");
  });
  it("ゼロ埋めを保つ", () => {
    expect(previousMonthOf("2026-02")).toBe("2026-01");
  });
});
