/**
 * スタッフ台帳の組み立て（P8-01）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例）/ security.md §5
 *
 * ── ここが見るのは 4 つ ─────────────────────────────────
 *   1. 台帳の行が無いスタッフも一覧から消えない（空欄で出る）
 *   2. 在籍年数が「未入力」と「0 年目」を取り違えない
 *   3. 言語の構成が 1 人複数言語で壊れない
 *   4. **在留期限は渡されなければ出ない**（門は呼び出し側 / INV-08）
 */

import type { OrgStaff, ResidencyRow, StaffLedgerRow } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  buildStaffLedger,
  daysUntil,
  expiringStaff,
  filterStaffRows,
  parseStaffFilter,
} from "./ledger.js";

const ORG = "a1b2c3";
const TODAY = "2026-08-20";

function person(overrides: Partial<OrgStaff> & { membershipId: string }): OrgStaff {
  return {
    userId: `${ORG}__usr_01JBXQ3ZK8N4P2VYR60000`,
    role: "CLEANER",
    staffNumber: "011",
    displayName: "テスト",
    locale: "ja",
    isActive: true,
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<StaffLedgerRow> & { membershipId: string }): StaffLedgerRow {
  return {
    id: `${ORG}__sppf_01JBXQ3ZK8N4P2VYR60000`,
    hiredOn: null,
    resignedOn: null,
    workStatus: "ACTIVE",
    languages: [],
    skills: [],
    note: null,
    ...overrides,
  };
}

function residencyRow(overrides: Partial<ResidencyRow> & { staffProfileId: string }): ResidencyRow {
  return {
    id: `${ORG}__resd_01JBXQ3ZK8N4P2VYR60000`,
    statusType: "SPECIFIED_SKILLED_1",
    statusLabel: null,
    expiresOn: "2026-11-30",
    renewalAppliedOn: null,
    workPermitRequired: false,
    weeklyHourLimit: null,
    note: null,
    ...overrides,
  };
}

function build(input: {
  staff: OrgStaff[];
  ledger?: StaffLedgerRow[];
  residency?: ResidencyRow[];
  expiringWithin90Days?: number;
  assignments?: { membershipId: string; propertyId: string }[];
  propertyNames?: Map<string, string>;
}) {
  return buildStaffLedger({
    staff: input.staff,
    ledger: input.ledger ?? [],
    residency: input.residency ?? [],
    businessDate: TODAY,
    expiringWithin90Days: input.expiringWithin90Days ?? 0,
    ...(input.assignments === undefined ? {} : { assignments: input.assignments }),
    ...(input.propertyNames === undefined ? {} : { propertyNames: input.propertyNames }),
  });
}

describe("buildStaffLedger — 一覧", () => {
  it("台帳の行が無いスタッフも一覧に出る（空欄で出す）", () => {
    const page = build({ staff: [person({ membershipId: `${ORG}__mem_A` })] });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.years).toBeNull();
    expect(page.rows[0]?.expiresOn).toBeNull();
  });

  it("退職者を一覧から消さない（KPI の分母が合わなくなる）", () => {
    const page = build({
      staff: [
        person({ membershipId: `${ORG}__mem_A` }),
        person({ membershipId: `${ORG}__mem_B`, isActive: false }),
      ],
      ledger: [ledgerRow({ membershipId: `${ORG}__mem_B`, workStatus: "RESIGNED" })],
    });
    expect(page.rows).toHaveLength(2);
    expect(page.summary.registered).toBe(2);
    expect(page.summary.active).toBe(1);
  });

  it("台帳の行が無ければ `membership.isActive` から状態を写す", () => {
    const page = build({
      staff: [person({ membershipId: `${ORG}__mem_A`, isActive: false })],
    });
    expect(page.rows[0]?.workStatus).toBe("RESIGNED");
  });
});

describe("buildStaffLedger — 在籍年数", () => {
  it("入社から 5 年 2 か月なら 5 年目", () => {
    const page = build({
      staff: [person({ membershipId: `${ORG}__mem_A` })],
      ledger: [ledgerRow({ membershipId: `${ORG}__mem_A`, hiredOn: "2021-06-01" })],
    });
    expect(page.rows[0]?.years).toBe(5);
    expect(page.rows[0]?.months).toBe(62);
  });

  it("入社 1 か月なら 0 年・1 か月（**`null` にしない**）", () => {
    const page = build({
      staff: [person({ membershipId: `${ORG}__mem_A` })],
      ledger: [ledgerRow({ membershipId: `${ORG}__mem_A`, hiredOn: "2026-07-12" })],
    });
    expect(page.rows[0]?.years).toBe(0);
    expect(page.rows[0]?.months).toBe(1);
  });

  it("入社日が未入力なら `null`（**0 年目と区別する**）", () => {
    const page = build({
      staff: [person({ membershipId: `${ORG}__mem_A` })],
      ledger: [ledgerRow({ membershipId: `${ORG}__mem_A`, hiredOn: null })],
    });
    expect(page.rows[0]?.years).toBeNull();
    expect(page.rows[0]?.months).toBeNull();
  });

  it("入社日が未来なら `null`（負の年数を出さない）", () => {
    const page = build({
      staff: [person({ membershipId: `${ORG}__mem_A` })],
      ledger: [ledgerRow({ membershipId: `${ORG}__mem_A`, hiredOn: "2027-01-01" })],
    });
    expect(page.rows[0]?.years).toBeNull();
  });

  it("入社日が壊れていれば `null`（例外にしない）", () => {
    const page = build({
      staff: [person({ membershipId: `${ORG}__mem_A` })],
      ledger: [ledgerRow({ membershipId: `${ORG}__mem_A`, hiredOn: "2026/07/12" })],
    });
    expect(page.rows[0]?.years).toBeNull();
  });
});

describe("buildStaffLedger — 言語の構成", () => {
  it("1 人が複数の言語を持てる", () => {
    const page = build({
      staff: [
        person({ membershipId: `${ORG}__mem_A` }),
        person({ membershipId: `${ORG}__mem_B` }),
      ],
      ledger: [
        ledgerRow({ membershipId: `${ORG}__mem_A`, languages: ["zh", "ja"] }),
        ledgerRow({ membershipId: `${ORG}__mem_B`, languages: ["zh"] }),
      ],
    });
    expect(page.languages).toEqual([
      { language: "zh", count: 2, ratio: 100 },
      { language: "ja", count: 1, ratio: 50 },
    ]);
  });

  it("台帳が空なら表示言語 1 つで代用する", () => {
    const page = build({ staff: [person({ membershipId: `${ORG}__mem_A`, locale: "vi" })] });
    expect(page.rows[0]?.languages).toEqual(["vi"]);
    expect(page.languages).toEqual([{ language: "vi", count: 1, ratio: 100 }]);
  });

  it("スタッフが 0 人でも壊れない（0 除算を作らない）", () => {
    const page = build({ staff: [] });
    expect(page.languages).toEqual([]);
    expect(page.summary.registered).toBe(0);
  });
});

describe("buildStaffLedger — 在留期限（INV-08）", () => {
  const staff = [person({ membershipId: `${ORG}__mem_A` })];
  const ledger = [
    ledgerRow({ membershipId: `${ORG}__mem_A`, id: `${ORG}__sppf_TARGET` }),
  ];

  it("渡されれば期限と残り日数が出る", () => {
    const page = build({
      staff,
      ledger,
      residency: [residencyRow({ staffProfileId: `${ORG}__sppf_TARGET`, expiresOn: "2026-10-14" })],
    });
    expect(page.rows[0]?.expiresOn).toBe("2026-10-14");
    expect(page.rows[0]?.daysUntilExpiry).toBe(55);
  });

  // ── 負例 ──────────────────────────────────────────────

  it("**渡されなければ出ない**（読めない相手には空配列を渡す）", () => {
    const page = build({ staff, ledger, residency: [] });
    expect(page.rows[0]?.expiresOn).toBeNull();
    expect(page.rows[0]?.daysUntilExpiry).toBeNull();
  });

  it("別のスタッフの在留資格が混ざらない", () => {
    const page = build({
      staff,
      ledger,
      residency: [residencyRow({ staffProfileId: `${ORG}__sppf_OTHER` })],
    });
    expect(page.rows[0]?.expiresOn).toBeNull();
  });

  it("期限の無い在留資格（日本国籍など）は残り日数も `null`", () => {
    const page = build({
      staff,
      ledger,
      residency: [residencyRow({ staffProfileId: `${ORG}__sppf_TARGET`, expiresOn: null })],
    });
    expect(page.rows[0]?.daysUntilExpiry).toBeNull();
  });

  it("件数の KPI は在留資格を渡さなくても出る（INV-08 の「件数のみ」）", () => {
    const page = build({ staff, ledger, residency: [], expiringWithin90Days: 2 });
    expect(page.summary.expiringWithin90Days).toBe(2);
    expect(page.rows[0]?.expiresOn).toBeNull();
  });

  it("実績の列を 1 つも持たない（security.md §5）", () => {
    const page = build({ staff, ledger });
    const keys = Object.keys(page.rows[0] ?? {});
    for (const forbidden of ["completed", "minutes", "rank", "score", "speed"]) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden))).toBe(false);
    }
  });
});

describe("daysUntil", () => {
  it("同じ日なら 0", () => {
    expect(daysUntil("2026-08-20", "2026-08-20")).toBe(0);
  });

  it("月をまたいで数えられる", () => {
    expect(daysUntil("2026-08-20", "2026-09-01")).toBe(12);
  });

  it("年をまたいで数えられる（うるう年を含む）", () => {
    expect(daysUntil("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("過去なら負", () => {
    expect(daysUntil("2026-08-20", "2026-08-19")).toBe(-1);
  });

  it("形が違えば `null`（例外にしない）", () => {
    expect(daysUntil("2026-08-20", "bad")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 主な担当施設（プロトタイプ ops 07）
// ────────────────────────────────────────────────────────────

describe("主な担当施設", () => {
  const MEMBERSHIP = `${ORG}__mbsh_01JBXQ3ZK8N4P2VYR60000`;
  const PROPERTY_A = `${ORG}__prop_01JBXQ3ZK8N4P2VYR60001`;
  const PROPERTY_B = `${ORG}__prop_01JBXQ3ZK8N4P2VYR60002`;
  const staff = [person({ membershipId: MEMBERSHIP })];
  const names = new Map([
    [PROPERTY_A, "サンプルホテル東京"],
    [PROPERTY_B, "サンプルイン大阪"],
  ]);

  it("割当が無ければ空配列（「全施設」と読み替えない）", () => {
    expect(build({ staff }).rows[0]?.properties).toEqual([]);
  });

  it("割当ぶんの施設名が並ぶ", () => {
    const page = build({
      staff,
      assignments: [
        { membershipId: MEMBERSHIP, propertyId: PROPERTY_A },
        { membershipId: MEMBERSHIP, propertyId: PROPERTY_B },
      ],
      propertyNames: names,
    });
    expect(page.rows[0]?.properties).toEqual(["サンプルホテル東京", "サンプルイン大阪"]);
  });

  it("名前を引けない施設は落とす（無効化された施設を空欄で出さない）", () => {
    const page = build({
      staff,
      assignments: [{ membershipId: MEMBERSHIP, propertyId: `${ORG}__prop_99` }],
      propertyNames: names,
    });
    expect(page.rows[0]?.properties).toEqual([]);
  });

  it("**他人の割当を混ぜない**", () => {
    const other = `${ORG}__mbsh_01JBXQ3ZK8N4P2VYR60009`;
    const page = build({
      staff,
      assignments: [{ membershipId: other, propertyId: PROPERTY_A }],
      propertyNames: names,
    });
    expect(page.rows[0]?.properties).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 在留資格の内訳（プロトタイプ ops 07）
// ────────────────────────────────────────────────────────────

describe("在留資格の内訳", () => {
  const MEMBERSHIP = `${ORG}__mbsh_01JBXQ3ZK8N4P2VYR60000`;
  const PROFILE = `${ORG}__sppf_01JBXQ3ZK8N4P2VYR60000`;
  const staff = [person({ membershipId: MEMBERSHIP })];
  const ledger = [ledgerRow({ membershipId: MEMBERSHIP, id: PROFILE })];

  it("渡されなければ空（`residency.read` を持たない相手）", () => {
    expect(build({ staff, ledger }).residencyBreakdown).toEqual([]);
  });

  it("種別ごとに数える", () => {
    const page = build({
      staff,
      ledger,
      residency: [residencyRow({ staffProfileId: PROFILE, statusType: "TRAINING_EMPLOYMENT" })],
    });
    expect(page.residencyBreakdown).toEqual([{ statusType: "TRAINING_EMPLOYMENT", count: 1 }]);
  });

  it("**台帳に居ない行の残骸を数えない**", () => {
    const page = build({
      staff,
      ledger,
      residency: [residencyRow({ staffProfileId: `${ORG}__sppf_99` })],
    });
    expect(page.residencyBreakdown).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// 絞り込みと期限の近い人（プロトタイプ ops 07）
// ────────────────────────────────────────────────────────────

describe("絞り込み", () => {
  const rows = [
    { workStatus: "ACTIVE" as const },
    { workStatus: "TRAINING" as const },
    { workStatus: "RESIGNED" as const },
  ].map((row, index) => ({
    membershipId: `m${String(index)}`,
    staffProfileId: null,
    displayName: "テスト",
    staffNumber: null,
    languages: [],
    years: null,
    months: null,
    expiresOn: null,
    daysUntilExpiry: null,
    properties: [],
    ...row,
  }));

  it.each([
    ["ALL", 3],
    ["ACTIVE", 1],
    ["TRAINING", 1],
  ])("%s は %i 件", (filter, expected) => {
    expect(filterStaffRows(rows, parseStaffFilter(filter)).length).toBe(expected);
  });

  it.each([null, "", "RESIGNED", "unknown"])("知らない値 %s は全員へ倒す", (value) => {
    expect(parseStaffFilter(value)).toBe("ALL");
  });
});

describe("期限が近い人", () => {
  function row(daysUntilExpiry: number | null, workStatus: "ACTIVE" | "RESIGNED" = "ACTIVE") {
    return {
      membershipId: `m${String(daysUntilExpiry ?? 0)}`,
      staffProfileId: null,
      displayName: "テスト",
      staffNumber: null,
      languages: [],
      years: null,
      months: null,
      workStatus,
      expiresOn: "2026-11-30",
      daysUntilExpiry,
      properties: [],
    };
  }

  it("90 日以内だけを拾う", () => {
    expect(expiringStaff([row(120), row(90), row(10)]).length).toBe(2);
  });

  it("**期限切れも拾う**（いちばん危ない状態を落とさない）", () => {
    expect(expiringStaff([row(-5)]).length).toBe(1);
  });

  it("退職者は拾わない", () => {
    expect(expiringStaff([row(10, "RESIGNED")])).toEqual([]);
  });

  it("期限の無い人は拾わない（日本国籍など）", () => {
    expect(expiringStaff([row(null)])).toEqual([]);
  });

  it("残り日数の少ない順に並ぶ", () => {
    expect(expiringStaff([row(80), row(-1), row(30)]).map((r) => r.daysUntilExpiry)).toEqual([
      -1, 30, 80,
    ]);
  });
});
