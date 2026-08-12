/**
 * 業務日の算出（P0-21）と、翌日・現地時刻（P1-22 / PK-SPEC-P1 §19.4）。
 *
 * ルール: .claude/rules/architecture.md §7
 *
 * **カレンダー日ではない。** 日締め時刻より前は前日の業務日になる。
 */

import { describe, expect, it } from "vitest";

import { businessDateOf, localClockOf, nextBusinessDate } from "./businessDate.js";

describe("businessDateOf — 日締め（§7）", () => {
  it("日締め後（JST 09:00）は当日", () => {
    expect(businessDateOf(new Date("2026-08-10T00:00:00.000Z"))).toBe("2026-08-10");
  });

  it("日締め前（JST 02:00）は前日", () => {
    expect(businessDateOf(new Date("2026-08-09T17:00:00.000Z"))).toBe("2026-08-09");
  });

  it("施設の日締め時刻を渡せる", () => {
    // JST 06:00。日締めが 07:00 なら前日ぶん。
    expect(businessDateOf(new Date("2026-08-09T21:00:00.000Z"), "Asia/Tokyo", "07:00")).toBe(
      "2026-08-09",
    );
  });
});

describe("nextBusinessDate — 翌日（§19.4）", () => {
  it("翌日を返す", () => {
    expect(nextBusinessDate("2026-08-10")).toBe("2026-08-11");
  });

  it("月をまたぐ", () => {
    expect(nextBusinessDate("2026-08-31")).toBe("2026-09-01");
  });

  it("年をまたぐ", () => {
    expect(nextBusinessDate("2026-12-31")).toBe("2027-01-01");
  });

  it("閏日をまたぐ", () => {
    expect(nextBusinessDate("2028-02-28")).toBe("2028-02-29");
  });

  it("平年の 2 月末は 3 月へ", () => {
    expect(nextBusinessDate("2026-02-28")).toBe("2026-03-01");
  });
});

describe("localClockOf — 現地時刻（§19.4 の「現在ここ」）", () => {
  it("JST の時分を返す", () => {
    expect(localClockOf(new Date("2026-08-10T00:30:00.000Z"))).toBe("09:30");
  });

  it("0 埋めする（辞書順の比較が成り立つ）", () => {
    expect(localClockOf(new Date("2026-08-09T22:05:00.000Z"))).toBe("07:05");
  });

  it("日締め前でも時計は時計（業務日と混ぜない）", () => {
    const at = new Date("2026-08-09T17:00:00.000Z"); // JST 02:00
    expect(localClockOf(at)).toBe("02:00");
    expect(businessDateOf(at)).toBe("2026-08-09");
  });

  it("タイムゾーンを渡せる", () => {
    expect(localClockOf(new Date("2026-08-10T00:00:00.000Z"), "UTC")).toBe("00:00");
  });

  it("午前 0 時は 00:00（24:00 にしない）", () => {
    expect(localClockOf(new Date("2026-08-09T15:00:00.000Z"))).toBe("00:00");
  });
});
