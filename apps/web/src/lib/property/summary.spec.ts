/**
 * 施設サマリーとキャッシュの検査。
 *
 * task: docs/tasks/P0-21.md
 */

import { describe, expect, it } from "vitest";

import { businessDateOf } from "../businessDate.js";
import { needsPropertySearch, summaryCacheKey } from "./summary.js";
import type { TenantContext } from "@pk/db";

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: "seed01__org_1",
    orgShortId: "seed01",
    role: "OWNER",
    allowedPropertyIds: [],
    now: new Date("2026-08-12T00:00:00.000Z"),
    ...overrides,
  };
}

describe("summaryCacheKey", () => {
  it("ロールが違えば別キー（施設責任者のキャッシュをオーナーが引かない）", () => {
    expect(summaryCacheKey(ctx({ role: "OWNER" }), "2026-08-12")).not.toBe(
      summaryCacheKey(ctx({ role: "AUDITOR" }), "2026-08-12"),
    );
  });

  it("担当施設が違えば別キー", () => {
    const a = summaryCacheKey(
      ctx({ role: "PROPERTY_MANAGER", allowedPropertyIds: ["seed01__prop_a"] }),
      "2026-08-12",
    );
    const b = summaryCacheKey(
      ctx({ role: "PROPERTY_MANAGER", allowedPropertyIds: ["seed01__prop_b"] }),
      "2026-08-12",
    );
    expect(a).not.toBe(b);
  });

  it("担当施設の順序が違うだけなら同じキー", () => {
    const a = summaryCacheKey(
      ctx({ role: "INSPECTOR", allowedPropertyIds: ["seed01__prop_b", "seed01__prop_a"] }),
      "2026-08-12",
    );
    const b = summaryCacheKey(
      ctx({ role: "INSPECTOR", allowedPropertyIds: ["seed01__prop_a", "seed01__prop_b"] }),
      "2026-08-12",
    );
    expect(a).toBe(b);
  });

  it("業務日が違えば別キー", () => {
    expect(summaryCacheKey(ctx(), "2026-08-12")).not.toBe(summaryCacheKey(ctx(), "2026-08-13"));
  });

  it("組織が違えば別キー", () => {
    expect(summaryCacheKey(ctx(), "2026-08-12")).not.toBe(
      summaryCacheKey(ctx({ organizationId: "other1__org_1" }), "2026-08-12"),
    );
  });
});

describe("needsPropertySearch", () => {
  it.each([
    [1, false],
    [8, false],
    [9, true],
    [30, true],
  ])("施設 %i 件 → %s", (count, expected) => {
    // §23.2「8 を超える場合」= 9 以上で検索入力を出す。
    expect(needsPropertySearch(count)).toBe(expected);
  });
});

describe("businessDateOf", () => {
  it.each([
    // 日締め 05:00 JST。JST は UTC+9。
    ["2026-08-12T00:00:00.000Z", "2026-08-12"], // 09:00 JST
    ["2026-08-11T19:59:00.000Z", "2026-08-11"], // 04:59 JST → 前日
    ["2026-08-11T20:00:00.000Z", "2026-08-12"], // 05:00 JST → 当日
    ["2026-08-11T14:00:00.000Z", "2026-08-11"], // 23:00 JST
    ["2026-01-01T19:00:00.000Z", "2026-01-01"], // 翌 01-02 04:00 JST → 前日
  ])("%s → %s", (iso, expected) => {
    expect(businessDateOf(new Date(iso))).toBe(expected);
  });

  it("日締め時刻を変えると境界が動く", () => {
    const at3am = new Date("2026-08-11T18:00:00.000Z"); // 8/12 03:00 JST
    expect(businessDateOf(at3am, "Asia/Tokyo", "05:00")).toBe("2026-08-11");
    expect(businessDateOf(at3am, "Asia/Tokyo", "02:00")).toBe("2026-08-12");
  });

  it("形の違う日締め時刻は既定（05:00）として扱う", () => {
    const at3am = new Date("2026-08-11T18:00:00.000Z");
    expect(businessDateOf(at3am, "Asia/Tokyo", "おかしな値")).toBe("2026-08-11");
    expect(businessDateOf(at3am, "Asia/Tokyo", "99:99")).toBe("2026-08-11");
  });

  it("カレンダー日をそのまま使っていない", () => {
    // 8/12 02:00 JST は暦の上では 8/12 だが、業務日は 8/11。
    expect(businessDateOf(new Date("2026-08-11T17:00:00.000Z"))).toBe("2026-08-11");
  });
});
