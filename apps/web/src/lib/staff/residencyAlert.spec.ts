/**
 * 在留資格の期限アラートの判定（P8-02 / PK-SPEC-P8 §1.4）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例）
 *
 * ── ここが守っているもの ────────────────────────────────
 *   1. 90 日は**ちょうどその日だけ**（89 日・91 日は数えない）
 *   2. 30 日以内は**毎日**、ただし更新手続きが出ていれば数えない
 *   3. 期限切れも 30 日側に入る（配分停止のまま放置させない）
 *   4. 退職者・期限なし・台帳に無い行の残骸を数えない
 */

import type { ResidencyRow, StaffLedgerRow } from "@pk/db";
import { describe, expect, it } from "vitest";

import { RESIDENCY_ALERT_CRON, countResidencyAlerts } from "./residencyAlert.js";

const ORG = "a1b2c3";
const TODAY = "2026-08-20";
/** `TODAY` の 90 日後。 */
const IN_90_DAYS = "2026-11-18";

let seq = 0;

function ledgerRow(overrides: Partial<StaffLedgerRow> = {}): StaffLedgerRow {
  seq += 1;
  return {
    id: `${ORG}__sppf_${String(seq).padStart(4, "0")}`,
    membershipId: `${ORG}__mem_${String(seq).padStart(4, "0")}`,
    hiredOn: null,
    resignedOn: null,
    workStatus: "ACTIVE",
    languages: [],
    skills: [],
    note: null,
    ...overrides,
  };
}

function residencyRow(
  staffProfileId: string,
  overrides: Partial<ResidencyRow> = {},
): ResidencyRow {
  return {
    id: `${ORG}__resd_${staffProfileId.slice(-4)}`,
    staffProfileId,
    statusType: "SPECIFIED_SKILLED_1",
    statusLabel: null,
    expiresOn: IN_90_DAYS,
    renewalAppliedOn: null,
    workPermitRequired: false,
    weeklyHourLimit: null,
    note: null,
    ...overrides,
  };
}

function count(ledger: StaffLedgerRow[], residency: ResidencyRow[]) {
  return countResidencyAlerts({ ledger, residency, businessDate: TODAY });
}

describe("RESIDENCY_ALERT_CRON", () => {
  it("07:00 JST（UTC では前日 22:00）", () => {
    expect(RESIDENCY_ALERT_CRON).toBe("0 22 * * *");
  });
});

describe("countResidencyAlerts — 90 日の初回通知", () => {
  it("ちょうど 90 日前なら数える", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: IN_90_DAYS })]);
    expect(result).toEqual({ firstNotice: 1, dueSoon: 0, total: 1 });
  });

  it("91 日前は数えない（**まだ 90 日ではない**）", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-11-19" })]);
    expect(result.total).toBe(0);
  });

  it("89 日前も数えない（**初回は 1 日だけ。翌日から静かになる**）", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-11-17" })]);
    expect(result.total).toBe(0);
  });

  it("更新手続きが出ていても 90 日の初回は数える（期限の 3 か月前に一度は目に入る）", () => {
    const staff = ledgerRow();
    const result = count(
      [staff],
      [residencyRow(staff.id, { expiresOn: IN_90_DAYS, renewalAppliedOn: "2026-08-01" })],
    );
    expect(result.firstNotice).toBe(1);
  });
});

describe("countResidencyAlerts — 30 日以内の再通知", () => {
  it("30 日ちょうどで数える", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-09-19" })]);
    expect(result).toEqual({ firstNotice: 0, dueSoon: 1, total: 1 });
  });

  it("15 日前も数える（**毎日この集合に入り続ける**）", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-09-04" })]);
    expect(result.dueSoon).toBe(1);
  });

  it("**期限切れも数える**（配分が止まったまま放置させない）", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-08-01" })]);
    expect(result.dueSoon).toBe(1);
  });

  it("**更新手続きが出ていれば数えない**（プロトタイプのトグルの但し書き）", () => {
    const staff = ledgerRow();
    const result = count(
      [staff],
      [residencyRow(staff.id, { expiresOn: "2026-09-01", renewalAppliedOn: "2026-08-15" })],
    );
    expect(result.total).toBe(0);
  });

  it("31 日前は数えない（89〜31 日は催促の間を空ける）", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-09-20" })]);
    expect(result.total).toBe(0);
  });
});

describe("countResidencyAlerts — 数えないもの", () => {
  it("退職者を数えない", () => {
    const staff = ledgerRow({ workStatus: "RESIGNED" });
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-09-01" })]);
    expect(result.total).toBe(0);
  });

  it("休職中は数える（在留資格の管理は雇用が続く限り要る）", () => {
    const staff = ledgerRow({ workStatus: "ON_LEAVE" });
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-09-01" })]);
    expect(result.total).toBe(1);
  });

  it("期限の無い在留資格（日本国籍など）を数えない", () => {
    const staff = ledgerRow();
    const result = count(
      [staff],
      [residencyRow(staff.id, { statusType: "NOT_APPLICABLE", expiresOn: null })],
    );
    expect(result.total).toBe(0);
  });

  it("台帳に無い行の残骸を数えない", () => {
    const result = count([], [residencyRow(`${ORG}__sppf_GONE`, { expiresOn: "2026-09-01" })]);
    expect(result.total).toBe(0);
  });

  it("壊れた日付を数えない（例外にしない）", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026/09/01" })]);
    expect(result.total).toBe(0);
  });
});

describe("countResidencyAlerts — 合算", () => {
  it("90 日と 30 日が別のスタッフなら足し合わせる", () => {
    const a = ledgerRow();
    const b = ledgerRow();
    const result = count(
      [a, b],
      [
        residencyRow(a.id, { expiresOn: IN_90_DAYS }),
        residencyRow(b.id, { expiresOn: "2026-09-01" }),
      ],
    );
    expect(result).toEqual({ firstNotice: 1, dueSoon: 1, total: 2 });
  });

  it("**個人を特定できる値を返さない**（人数だけ / ui-writing.md §6）", () => {
    const staff = ledgerRow();
    const result = count([staff], [residencyRow(staff.id, { expiresOn: "2026-09-01" })]);
    expect(Object.keys(result).sort()).toEqual(["dueSoon", "firstNotice", "total"]);
  });
});
