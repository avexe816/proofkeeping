/**
 * 在留資格の保存期間の判定（P8-11）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例を 5 件ずつ）
 *
 * ── ここが守るのは「消しすぎない」こと ──────────────────
 * 物理削除は取り返しがつかない。**負例（消さない側）を厚くしてある。**
 */

import type { ResidencyRow, StaffLedgerRow } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  RESIDENCY_RETENTION_YEARS,
  retentionDueOn,
  selectResidencyForDeletion,
} from "./residencyRetention.js";

const ORG = "a1b2c3";
const TODAY = "2026-08-22";
const PROFILE = `${ORG}__sppf_01JBXQ3ZK8N4P2VYR60000`;

function ledgerRow(overrides: Partial<StaffLedgerRow> = {}): StaffLedgerRow {
  return {
    id: PROFILE,
    membershipId: `${ORG}__mem_01JBXQ3ZK8N4P2VYR60000`,
    hiredOn: "2019-04-01",
    resignedOn: "2023-08-22",
    workStatus: "RESIGNED",
    languages: [],
    skills: [],
    note: null,
    ...overrides,
  };
}

function residencyRow(overrides: Partial<ResidencyRow> = {}): ResidencyRow {
  return {
    id: `${ORG}__resd_01JBXQ3ZK8N4P2VYR60000`,
    staffProfileId: PROFILE,
    statusType: "SPECIFIED_SKILLED_1",
    statusLabel: null,
    expiresOn: "2024-03-31",
    renewalAppliedOn: null,
    workPermitRequired: false,
    weeklyHourLimit: null,
    note: null,
    ...overrides,
  };
}

function select(ledger: StaffLedgerRow[], residency: ResidencyRow[], businessDate = TODAY) {
  return selectResidencyForDeletion({ ledger, residency, businessDate });
}

describe("retentionDueOn", () => {
  it("退職日の 3 年後の同じ日", () => {
    expect(retentionDueOn("2023-08-22")).toBe("2026-08-22");
  });

  it("年をまたいでも月日は変わらない", () => {
    expect(retentionDueOn("2023-01-01")).toBe("2026-01-01");
  });

  it("**2 月 29 日は 2 月末へ丸める**（3 月 1 日へ送らない）", () => {
    // 2024 はうるう年。3 年後の 2027 年 2 月は 28 日まで。
    expect(retentionDueOn("2024-02-29")).toBe("2027-02-28");
  });

  it("うるう年へ着地する場合は 29 日のまま", () => {
    // 2021-02-28 の 3 年後は 2024-02-28（うるう年だが 28 日は在る）。
    expect(retentionDueOn("2021-02-28")).toBe("2024-02-28");
  });

  it("月末（31 日）はそのまま", () => {
    expect(retentionDueOn("2023-12-31")).toBe("2026-12-31");
  });

  it.each(["2023/08/22", "20230822", "", "bad", "2023-8-2"])(
    "形が違えば `null`（%s）",
    (value) => {
      expect(retentionDueOn(value)).toBeNull();
    },
  );

  // ── 暦として実在しない日付（hotfix 2026-08-22）──────────
  // 以前は形しか見ておらず、これらが**削除対象になっていた。**
  it.each([
    ["2023-02-29", "平年の 2 月 29 日"],
    ["2023-02-30", "2 月 30 日"],
    ["2023-02-31", "2 月 31 日"],
    ["2023-04-31", "4 月 31 日"],
    ["2023-06-31", "6 月 31 日"],
    ["2023-00-15", "0 月"],
    ["2023-13-01", "13 月"],
    ["2023-01-00", "0 日"],
    ["2023-01-32", "1 月 32 日"],
    ["2023-12-32", "12 月 32 日"],
  ])("**暦に無い日付は `null`**（%s / %s）", (value) => {
    expect(retentionDueOn(value)).toBeNull();
  });

  it.each(["2024-02-29", "2023-08-20", "2023-12-31", "2020-02-29", "2023-01-01"])(
    "実在する日付は受け付ける（%s）",
    (value) => {
      expect(retentionDueOn(value)).not.toBeNull();
    },
  );

  it("**戻り値は常に暦として実在する日付**（`2026-00-15` のような文字列を返さない）", () => {
    // 4 年ぶん（うるう年を含む）の全ての日と、その周辺の壊れた値を通す。
    for (let year = 2020; year <= 2024; year += 1) {
      for (let month = 0; month <= 13; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          const input = `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const due = retentionDueOn(input);
          if (due === null) continue;
          const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
          expect(match, `${input} -> ${due}`).not.toBeNull();
          const [, dy, dm, dd] = match ?? [];
          const yy = Number(dy);
          const mm = Number(dm);
          const ddn = Number(dd);
          expect(mm, due).toBeGreaterThanOrEqual(1);
          expect(mm, due).toBeLessThanOrEqual(12);
          expect(ddn, due).toBeGreaterThanOrEqual(1);
          // `Date.UTC` が繰り上げずに同じ日を返す＝実在する日付。
          const asDate = new Date(Date.UTC(yy, mm - 1, ddn));
          expect(asDate.getUTCMonth(), due).toBe(mm - 1);
          expect(asDate.getUTCDate(), due).toBe(ddn);
        }
      }
    }
  });

  it("保存期間は 3 年", () => {
    expect(RESIDENCY_RETENTION_YEARS).toBe(3);
  });
});

describe("削除の対象になる（正例）", () => {
  it("**満了日の翌日**（2023-08-21 退職 → 満了 2026-08-21 → 基準日 2026-08-22）", () => {
    expect(select([ledgerRow({ resignedOn: "2023-08-21" })], [residencyRow()])).toEqual([PROFILE]);
  });

  it("退職から 3 年を過ぎている", () => {
    expect(select([ledgerRow({ resignedOn: "2020-01-01" })], [residencyRow()])).toEqual([PROFILE]);
  });

  it("在留期限が未来でも、退職から 3 年経っていれば対象", () => {
    // 消す理由は雇用の終了であって、期限ではない。
    const record = residencyRow({ expiresOn: "2030-12-31" });
    expect(select([ledgerRow({ resignedOn: "2020-01-01" })], [record])).toEqual([PROFILE]);
  });

  it("在留期限が空（日本国籍など）でも対象", () => {
    const record = residencyRow({ expiresOn: null, statusType: "NOT_APPLICABLE" });
    expect(select([ledgerRow({ resignedOn: "2020-01-01" })], [record])).toEqual([PROFILE]);
  });

  it("**2 月 29 日の満了日の翌日から対象**（2024-02-29 退職 → 2027-03-01）", () => {
    const staff = ledgerRow({ resignedOn: "2024-02-29" });
    expect(select([staff], [residencyRow()], "2027-03-01")).toEqual([PROFILE]);
  });

  it("複数人ぶんをまとめて返す（並びは決まっている）", () => {
    const otherProfile = `${ORG}__sppf_01JBXQ3ZK8N4P2VYR69999`;
    const ledger = [
      ledgerRow({ resignedOn: "2020-01-01" }),
      ledgerRow({ id: otherProfile, resignedOn: "2019-05-05" }),
    ];
    const residency = [residencyRow(), residencyRow({ staffProfileId: otherProfile })];
    expect(select(ledger, residency)).toEqual([PROFILE, otherProfile].sort());
  });
});

describe("削除の対象にならない（負例）", () => {
  it("**在職中は在留期限が切れていても消さない**", () => {
    const staff = ledgerRow({ workStatus: "ACTIVE", resignedOn: null });
    const record = residencyRow({ expiresOn: "2020-01-01" });
    expect(select([staff], [record])).toEqual([]);
  });

  it("**退職日が入っていなければ消さない**（推測しない）", () => {
    expect(select([ledgerRow({ workStatus: "RESIGNED", resignedOn: null })], [residencyRow()])).toEqual(
      [],
    );
  });

  it("退職から 3 年に 1 日足りない", () => {
    // 2023-08-23 退職 → 満了は 2026-08-23。基準日は 2026-08-22。
    expect(select([ledgerRow({ resignedOn: "2023-08-23" })], [residencyRow()])).toEqual([]);
  });

  it("**満了日当日は消さない**（2023-08-22 退職 → 満了 2026-08-22 = 基準日）", () => {
    // 民法 140 条（初日不算入）で数えると、3 年の満了は当日の終了時。
    // 07:00 JST のバッチで消すと 17 時間ほど早い。
    expect(select([ledgerRow({ resignedOn: "2023-08-22" })], [residencyRow()])).toEqual([]);
  });

  it("**2 月 29 日の満了日当日も消さない**（2024-02-29 退職 → 満了 2027-02-28）", () => {
    const staff = ledgerRow({ resignedOn: "2024-02-29" });
    expect(select([staff], [residencyRow()], "2027-02-28")).toEqual([]);
  });

  it.each([
    "2023-02-29",
    "2023-02-30",
    "2023-02-31",
    "2023-04-31",
    "2023-00-15",
    "2023-13-01",
    "2023-01-00",
    "2023-01-32",
  ])("**暦に無い退職日は消さない**（%s）", (resignedOn) => {
    expect(select([ledgerRow({ resignedOn })], [residencyRow()])).toEqual([]);
  });

  it("退職したばかり", () => {
    expect(select([ledgerRow({ resignedOn: "2026-08-01" })], [residencyRow()])).toEqual([]);
  });

  it("研修中（在職）は消さない", () => {
    const staff = ledgerRow({ workStatus: "TRAINING", resignedOn: null });
    expect(select([staff], [residencyRow()])).toEqual([]);
  });

  it("**台帳に居ない記録は消さない**（退職日が分からない）", () => {
    expect(select([], [residencyRow()])).toEqual([]);
  });

  it("退職日の形が壊れていれば消さない", () => {
    expect(select([ledgerRow({ resignedOn: "2023/08/22" })], [residencyRow()])).toEqual([]);
  });

  it("在留資格の記録が無ければ何も返さない", () => {
    expect(select([ledgerRow()], [])).toEqual([]);
  });
});

describe("戻り値の形", () => {
  it("**`staffProfileId` だけを返す**（種別や期限を持ち出さない）", () => {
    const result = select([ledgerRow({ resignedOn: "2020-01-01" })], [residencyRow()]);
    for (const value of result) {
      expect(typeof value).toBe("string");
      expect(value).toBe(PROFILE);
    }
  });

  it("同じ入力なら同じ結果（決定的）", () => {
    const ledger = [ledgerRow({ resignedOn: "2020-01-01" })];
    const residency = [residencyRow()];
    expect(select(ledger, residency)).toEqual(select(ledger, residency));
  });
});
