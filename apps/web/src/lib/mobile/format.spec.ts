/**
 * 現場画面の書式（PK-SPEC-P1 §9.2・§9.3）。
 *
 * task: docs/tasks/P1-08.md / docs/tasks/P1-09.md
 */

import { describe, expect, it } from "vitest";

import { elapsedMinutes, formatClock, formatElapsed, formatShortDate } from "./format.js";

describe("formatElapsed", () => {
  it("1 時間未満は MM:SS", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(23 * 60_000)).toBe("23:00");
    expect(formatElapsed(65_000)).toBe("01:05");
  });

  it("1 時間を超えたら H:MM:SS", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });

  it("負の値は 0 に倒す（時刻のずれで巻き戻っても崩れない）", () => {
    expect(formatElapsed(-5_000)).toBe("00:00");
  });
});

describe("elapsedMinutes", () => {
  it("切り捨て（実測より多い側へ丸めない）", () => {
    expect(elapsedMinutes(59_999)).toBe(0);
    expect(elapsedMinutes(60_000)).toBe(1);
    expect(elapsedMinutes(119_999)).toBe(1);
  });

  it("負の値は 0", () => {
    expect(elapsedMinutes(-1)).toBe(0);
  });
});

describe("formatClock", () => {
  it("施設のタイムゾーンで出す（端末の設定を使わない）", () => {
    // 2026-08-12T00:30:00Z = 09:30 JST
    const epoch = Date.UTC(2026, 7, 12, 0, 30);
    expect(formatClock(epoch)).toBe("09:30");
    expect(formatClock(epoch, "UTC")).toBe("00:30");
  });
});

describe("formatShortDate", () => {
  it("YYYY-MM-DD を M/D に縮める", () => {
    expect(formatShortDate("2026-08-12")).toBe("8/12");
    expect(formatShortDate("2026-01-03")).toBe("1/3");
  });

  it("形が違えばそのまま返す", () => {
    expect(formatShortDate("")).toBe("");
    expect(formatShortDate("20260812")).toBe("20260812");
  });
});
