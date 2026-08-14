/**
 * 月次締めの期間と状態遷移のテスト（PK-SPEC-P5 §2.8・§6.1）。
 *
 * task:  docs/tasks/P5-05.md
 * ルール: .claude/rules/testing.md §3（正例と負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  BILLING_PERIOD_ACTIONS,
  BILLING_PERIOD_STATUS_VALUES,
  closedPeriodAsOf,
  closingDateOf,
  counterpartyPropertyScope,
  evaluateBillingPeriodTransition,
  type BillingPeriodAction,
  type BillingPeriodStatusValue,
} from "./period.js";

describe("closingDateOf", () => {
  it("その月に締め日があればその日", () => {
    expect(closingDateOf(2026, 9, 20)).toBe("2026-09-20");
    expect(closingDateOf(2026, 1, 5)).toBe("2026-01-05");
  });

  it("31 日締めは月末", () => {
    expect(closingDateOf(2026, 9, 31)).toBe("2026-09-30");
    expect(closingDateOf(2026, 10, 31)).toBe("2026-10-31");
  });

  it("2 月は締め日が消えずに末日へ寄る", () => {
    expect(closingDateOf(2026, 2, 31)).toBe("2026-02-28");
    expect(closingDateOf(2026, 2, 30)).toBe("2026-02-28");
    // 2028 は閏年。
    expect(closingDateOf(2028, 2, 31)).toBe("2028-02-29");
  });
});

describe("closedPeriodAsOf", () => {
  it("月末締め: 10/1 に走ると 9 月分", () => {
    expect(closedPeriodAsOf(31, "2026-10-01")).toEqual({
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
    });
  });

  it("月末締め: 1/1 に走ると前年 12 月分", () => {
    expect(closedPeriodAsOf(31, "2027-01-01")).toEqual({
      periodFrom: "2026-12-01",
      periodTo: "2026-12-31",
    });
  });

  it("20 日締め: 10/1 に走ると 8/21〜9/20", () => {
    expect(closedPeriodAsOf(20, "2026-10-01")).toEqual({
      periodFrom: "2026-08-21",
      periodTo: "2026-09-20",
    });
  });

  it("20 日締め: 10/21 に走ると 9/21〜10/20", () => {
    expect(closedPeriodAsOf(20, "2026-10-21")).toEqual({
      periodFrom: "2026-09-21",
      periodTo: "2026-10-20",
    });
  });

  it("2 月をまたぐ 31 日締め", () => {
    expect(closedPeriodAsOf(31, "2026-03-01")).toEqual({
      periodFrom: "2026-02-01",
      periodTo: "2026-02-28",
    });
  });

  it("2 月をまたぐ 30 日締め（締め日が末日へ寄る）", () => {
    expect(closedPeriodAsOf(30, "2026-03-15")).toEqual({
      periodFrom: "2026-01-31",
      periodTo: "2026-02-28",
    });
  });

  // ── 負例: まだ締まっていない期間を返さない ──────────────
  it("締め日当日はまだ締まっていない（前の期間を返す）", () => {
    // 20 日締めの 9/20 当日。その日の作業はまだ増えうる。
    expect(closedPeriodAsOf(20, "2026-09-20")).toEqual({
      periodFrom: "2026-07-21",
      periodTo: "2026-08-20",
    });
  });

  it("締め日の翌日に初めてその期間が締まる", () => {
    expect(closedPeriodAsOf(20, "2026-09-21")).toEqual({
      periodFrom: "2026-08-21",
      periodTo: "2026-09-20",
    });
  });

  it("期間は隙間なく連続する", () => {
    const first = closedPeriodAsOf(20, "2026-09-21");
    const second = closedPeriodAsOf(20, "2026-10-21");
    const dayAfterFirst = new Date(`${first.periodTo}T00:00:00.000Z`);
    dayAfterFirst.setUTCDate(dayAfterFirst.getUTCDate() + 1);
    expect(second.periodFrom).toBe(dayAfterFirst.toISOString().slice(0, 10));
  });

  it("同じ入力なら何度呼んでも同じ期間（冪等）", () => {
    const runs = [1, 2, 3].map(() => closedPeriodAsOf(31, "2026-10-01"));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

describe("evaluateBillingPeriodTransition", () => {
  // ── 正例（§6.1 の一本道）──────────────────────────────
  it.each([
    ["OPEN", "AGGREGATE", "REVIEWING"],
    ["REVIEWING", "AGREE", "AGREED"],
    ["AGREED", "ISSUE_INVOICE", "INVOICED"],
    ["INVOICED", "CLOSE", "CLOSED"],
    ["REVIEWING", "REJECT", "REVIEWING"],
    ["AGREED", "REJECT", "REVIEWING"],
  ] as const)("%s に %s は許される → %s", (from, action, to) => {
    expect(evaluateBillingPeriodTransition(from, action)).toEqual({ allowed: true, next: to });
  });

  // ── 負例 ────────────────────────────────────────────
  it.each([
    // 集計は 1 回だけ。締め直して金額が動くと送った請求書と食い違う。
    ["REVIEWING", "AGGREGATE"],
    ["INVOICED", "AGGREGATE"],
    // 合意していない期間から請求書を出せない。
    ["REVIEWING", "ISSUE_INVOICE"],
    ["OPEN", "ISSUE_INVOICE"],
    // 発行済みを差し戻さない（訂正は赤伝 / §5）。
    ["INVOICED", "REJECT"],
    ["CLOSED", "REJECT"],
    // 入金前に閉じない。
    ["AGREED", "CLOSE"],
    ["OPEN", "CLOSE"],
    // 閉じたあとは何も起こらない。
    ["CLOSED", "AGREE"],
    ["CLOSED", "ISSUE_INVOICE"],
  ] as const)("%s に %s は許されない", (from, action) => {
    expect(evaluateBillingPeriodTransition(from, action)).toEqual({
      allowed: false,
      reason: "INVALID_TRANSITION",
    });
  });

  it("CLOSED からはどの操作も起こせない", () => {
    for (const action of BILLING_PERIOD_ACTIONS) {
      expect(evaluateBillingPeriodTransition("CLOSED", action).allowed).toBe(false);
    }
  });

  it("すべての状態 × 操作で例外を投げない（表に穴が無い）", () => {
    for (const status of BILLING_PERIOD_STATUS_VALUES) {
      for (const action of BILLING_PERIOD_ACTIONS) {
        expect(() =>
          evaluateBillingPeriodTransition(
            status satisfies BillingPeriodStatusValue,
            action satisfies BillingPeriodAction,
          ),
        ).not.toThrow();
      }
    }
  });
});

describe("counterpartyPropertyScope", () => {
  it("施設を指定しない行が 1 つでもあれば全施設", () => {
    expect(
      counterpartyPropertyScope([{ propertyId: "o1__prop_a" }, { propertyId: null }]),
    ).toEqual({ kind: "ALL_PROPERTIES" });
  });

  it("施設つきの行だけなら、その施設に限る", () => {
    expect(
      counterpartyPropertyScope([{ propertyId: "o1__prop_b" }, { propertyId: "o1__prop_a" }]),
    ).toEqual({ kind: "LISTED", propertyIds: ["o1__prop_a", "o1__prop_b"] });
  });

  it("重複を畳む", () => {
    expect(
      counterpartyPropertyScope([{ propertyId: "o1__prop_a" }, { propertyId: "o1__prop_a" }]),
    ).toEqual({ kind: "LISTED", propertyIds: ["o1__prop_a"] });
  });

  it("料金設定が無ければ施設も無い（全施設にしない）", () => {
    expect(counterpartyPropertyScope([])).toEqual({ kind: "LISTED", propertyIds: [] });
  });

  it("並び順は入力に依存しない（冪等）", () => {
    const a = counterpartyPropertyScope([{ propertyId: "o1__prop_b" }, { propertyId: "o1__prop_a" }]);
    const b = counterpartyPropertyScope([{ propertyId: "o1__prop_a" }, { propertyId: "o1__prop_b" }]);
    expect(a).toEqual(b);
  });
});
