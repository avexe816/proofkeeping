/**
 * 表示計算のテスト（P5-14 / PK-SPEC-P5 §7.1）。
 *
 * **分母 0 を 0% と書かない**ことがこの層の要（`format.ts` の注記）。
 * 正例と負例を並べて固定する。
 */

import { LOW_HOURLY_RATE_PERCENT } from "@pk/contracts";
import { describe, expect, it } from "vitest";

import {
  NO_VALUE,
  costPerTask,
  formatAverageMinutes,
  formatHours,
  formatPercent,
  formatYen,
  hourlyRate,
  isLowHourlyRate,
  orDash,
} from "./format.js";

describe("formatPercent", () => {
  it.each([
    [2796, 2847, "98.2%"],
    [2602, 2847, "91.4%"],
    [245, 2847, "8.6%"],
    [1, 1, "100.0%"],
    [0, 10, "0.0%"],
  ])("%i / %i → %s", (numerator, denominator, expected) => {
    expect(formatPercent(numerator, denominator)).toBe(expected);
  });

  it.each([
    [0, 0],
    [5, 0],
    [3, -1],
  ])("分母が %i / %i なら null（0%% と書かない）", (numerator, denominator) => {
    expect(formatPercent(numerator, denominator)).toBeNull();
  });
});

describe("formatAverageMinutes", () => {
  it.each([
    [80_600, 2847, "28.3"],
    [37_842, 1412, "26.8"],
    [60, 2, "30.0"],
    [0, 5, "0.0"],
    [95, 4, "23.8"],
  ])("%i 分 / %i 件 → %s", (totalMinutes, completed, expected) => {
    expect(formatAverageMinutes(totalMinutes, completed)).toBe(expected);
  });

  it("完了が 0 件なら null", () => {
    expect(formatAverageMinutes(120, 0)).toBeNull();
  });

  it("単位を含めない（`t()` が付ける）", () => {
    expect(formatAverageMinutes(283, 10)).not.toContain("分");
  });
});

describe("costPerTask — 分母は清掃実績（客室数ではない）", () => {
  it("§7.1 の見本の数字と合う", () => {
    // 8,241,600 円 ÷ 2,847 件 = 2,894.8… → 2,894 円
    expect(costPerTask(8_241_600, 2847)).toBe(2894);
  });

  it.each([
    [3_925_360, 1412, 2780],
    [2_896_900, 982, 2950],
    [1_413_360, 453, 3120],
    [1000, 3, 333],
    [0, 5, 0],
  ])("%i 円 / %i 件 → %i 円", (cost, tasks, expected) => {
    expect(costPerTask(cost, tasks)).toBe(expected);
  });

  it("**切り捨てる。** 円未満を持ち回らない（billing.md §4）", () => {
    expect(costPerTask(999, 2)).toBe(499);
  });

  it("費用が未確定なら null", () => {
    expect(costPerTask(null, 100)).toBeNull();
  });

  it("実績が 0 件なら null", () => {
    expect(costPerTask(100_000, 0)).toBeNull();
  });
});

describe("formatYen", () => {
  it.each([
    [8_241_600, "¥8,241,600"],
    [1_113_860, "¥1,113,860"],
    [2894, "¥2,894"],
    [0, "¥0"],
    [-5000, "¥-5,000"],
  ])("%i → %s", (amount, expected) => {
    expect(formatYen(amount)).toBe(expected);
  });

  it("null はそのまま", () => {
    expect(formatYen(null)).toBeNull();
  });
});

describe("orDash", () => {
  it("値があればそのまま", () => {
    expect(orDash("98.2%")).toBe("98.2%");
  });

  it("null は — にする（0 と区別する）", () => {
    expect(orDash(null)).toBe(NO_VALUE);
    expect(NO_VALUE).not.toBe("0");
  });
});

// ────────────────────────────────────────────────────────────
// 清掃会社プラン（P5-15 / PK-SPEC-P5 §7.2）
// ────────────────────────────────────────────────────────────

describe("formatHours", () => {
  it.each([
    [37_860, "631"],
    [28_680, "478"],
    [14_700, "245"],
    [59, "0"],
    [0, "0"],
  ])("%i 分 → %s 時間（切り捨て）", (minutes, expected) => {
    expect(formatHours(minutes)).toBe(expected);
  });
});

describe("hourlyRate", () => {
  // §7.2 の見本（1,113,860 円 / 631h → ¥1,765）。**切り捨てる。**
  // 見本の ¥1,625 は 1,624.9 を丸めた値で、ここは 1,624 になる
  // （`costPerTask()` と同じ扱い。表示のための数字を切り上げない）。
  it.each([
    [1_113_860, 37_860, 1765],
    [842_300, 28_680, 1762],
    [398_100, 14_700, 1624],
  ])("%i 円 / %i 分 → %i 円", (amount, minutes, expected) => {
    expect(hourlyRate(amount, minutes)).toBe(expected);
  });

  it("分を時間へ直してから割らない（端数で単価がずれる）", () => {
    // 90 分 = 1.5 時間。時間へ切り捨ててから割ると 3,000 円になる。
    expect(hourlyRate(3000, 90)).toBe(2000);
  });

  it.each([
    [null, 1000],
    [1000, 0],
    [1000, -1],
  ])("請求額 %s / 実働 %i 分 なら null（0 円と書かない）", (amount, minutes) => {
    expect(hourlyRate(amount, minutes)).toBeNull();
  });
});

describe("isLowHourlyRate", () => {
  it.each([
    [1624, 1911],
    [0, 1911],
    [1, 100],
  ])("単価 %i が平均 %i の 85% 未満なら真", (rate, average) => {
    expect(isLowHourlyRate(rate, average)).toBe(true);
  });

  it.each([
    [1765, 1911],
    [1762, 1911],
    [1911, 1911],
    [3000, 1911],
    // ちょうど 85%（境界）。**「下回る」なので含めない。**
    [850, 1000],
  ])("単価 %i が平均 %i の 85% 以上なら偽", (rate, average) => {
    expect(isLowHourlyRate(rate, average)).toBe(false);
  });

  it.each([
    [null, 1911],
    [1000, null],
    [1000, 0],
  ])("単価 %s / 平均 %s のどちらかが無ければ警告しない", (rate, average) => {
    expect(isLowHourlyRate(rate, average)).toBe(false);
  });

  it("しきい値は契約側の整数を既定にする（0.85 を掛けない）", () => {
    expect(LOW_HOURLY_RATE_PERCENT).toBe(85);
    expect(isLowHourlyRate(849, 1000, LOW_HOURLY_RATE_PERCENT)).toBe(true);
  });
});
