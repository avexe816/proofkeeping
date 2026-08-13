/**
 * 日報の自動生成のタイミングの検査（PK-SPEC-P2 §9.3）。
 *
 * task: docs/tasks/P2-14.md
 */

import { describe, expect, it } from "vitest";

import { dueBusinessDate } from "./schedule.js";

const TOKYO = { timezone: "Asia/Tokyo", dayCutoffTime: "05:00" };

/** JST の時刻から `Date` を作る（JST = UTC+9、夏時間なし）。 */
function jst(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0));
}

describe("日締めの 10 分後に生成する", () => {
  it("05:10 の回で生成する", () => {
    expect(dueBusinessDate(jst(2026, 9, 11, 5, 10), TOKYO)).toBe("2026-09-10");
  });

  it.each([
    ["日締めちょうど", 5, 0],
    ["日締めの 5 分後（まだ）", 5, 5],
    ["20 分後（窓を過ぎた）", 5, 20],
    ["昼", 12, 0],
    ["前日の 23:50", 23, 50],
  ])("%s は生成しない", (_label, hour, minute) => {
    expect(dueBusinessDate(jst(2026, 9, 11, hour, minute), TOKYO)).toBeNull();
  });

  it("1 日の中で生成の回はちょうど 1 回", () => {
    const hits: string[] = [];
    for (let tick = 0; tick < (24 * 60) / 10; tick++) {
      const at = new Date(Date.UTC(2026, 8, 10, 15, 0, 0) + tick * 10 * 60 * 1000);
      const due = dueBusinessDate(at, TOKYO);
      if (due !== null) hits.push(due);
    }
    expect(hits).toEqual(["2026-09-10"]);
  });
});

describe("施設ごとの日締めに追随する", () => {
  it.each([
    ["03:00 の施設は 03:10", { timezone: "Asia/Tokyo", dayCutoffTime: "03:00" }, 3, 10],
    ["06:00 の施設は 06:10", { timezone: "Asia/Tokyo", dayCutoffTime: "06:00" }, 6, 10],
    ["00:00 の施設は 00:10", { timezone: "Asia/Tokyo", dayCutoffTime: "00:00" }, 0, 10],
    ["12:00 の施設は 12:10", { timezone: "Asia/Tokyo", dayCutoffTime: "12:00" }, 12, 10],
  ])("%s", (_label, property, hour, minute) => {
    expect(dueBusinessDate(jst(2026, 9, 11, hour, minute), property)).not.toBeNull();
    expect(dueBusinessDate(jst(2026, 9, 11, hour, minute + 20), property)).toBeNull();
  });

  it("分単位の日締め（05:07）は次の刻み（05:20）で拾う", () => {
    const property = { timezone: "Asia/Tokyo", dayCutoffTime: "05:07" };
    expect(dueBusinessDate(jst(2026, 9, 11, 5, 10), property)).toBeNull();
    expect(dueBusinessDate(jst(2026, 9, 11, 5, 20), property)).toBe("2026-09-10");
  });

  it("日締めが 23:55 でも窓が日付をまたいで成り立つ", () => {
    const property = { timezone: "Asia/Tokyo", dayCutoffTime: "23:55" };
    // 23:55 + 10 分 = 翌 00:05。刻みの 00:00 は窓の手前、00:10 が窓の中。
    expect(dueBusinessDate(jst(2026, 9, 11, 0, 0), property)).toBeNull();
    expect(dueBusinessDate(jst(2026, 9, 11, 0, 10), property)).toBe("2026-09-09");
  });

  it("タイムゾーンが違えば発火する UTC 時刻も違う", () => {
    const tokyo = dueBusinessDate(jst(2026, 9, 11, 5, 10), TOKYO);
    const utc = dueBusinessDate(jst(2026, 9, 11, 5, 10), {
      timezone: "UTC",
      dayCutoffTime: "05:00",
    });
    expect(tokyo).toBe("2026-09-10");
    expect(utc).toBeNull();
  });
});

describe("生成する業務日", () => {
  it.each([
    ["9/11 05:10 → 9/10", 2026, 9, 11, "2026-09-10"],
    ["1/1 05:10 → 前年 12/31", 2027, 1, 1, "2026-12-31"],
    ["3/1 05:10 → 2/28（平年）", 2027, 3, 1, "2027-02-28"],
    ["3/1 05:10 → 2/29（うるう年）", 2028, 3, 1, "2028-02-29"],
    ["10/1 05:10 → 9/30", 2026, 10, 1, "2026-09-30"],
  ])("%s", (_label, year, month, day, expected) => {
    expect(dueBusinessDate(jst(year, month, day, 5, 10), TOKYO)).toBe(expected);
  });
});
