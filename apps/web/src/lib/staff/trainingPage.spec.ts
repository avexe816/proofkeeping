/**
 * 研修と資格の画面の組み立て（P8-10）。
 *
 * ルール: .claude/rules/testing.md §3 / security.md §5
 *
 * ── ここが守っているもの ────────────────────────────────
 *   1. 進捗が「N / 全項目」だけ（点数・順位・速さが無い）
 *   2. 無効化したプログラムを分母に入れない
 *   3. 更新必要の判定が 60 日（通知の刻みと同じ定数）
 */

import type {
  CertificationRow,
  OrgStaff,
  StaffLedgerRow,
  TrainingProgramRow,
  TrainingRecordRow,
} from "@pk/db";
import { describe, expect, it } from "vitest";

import { buildTrainingPage, DEFAULT_TRAINING_PROGRAMS } from "./trainingPage.js";

const ORG = "a1b2c3";
const TODAY = "2026-08-20";

let seq = 0;

function person(overrides: Partial<OrgStaff> = {}): OrgStaff {
  seq += 1;
  return {
    membershipId: `${ORG}__mem_${String(seq).padStart(4, "0")}`,
    userId: `${ORG}__usr_${String(seq).padStart(4, "0")}`,
    role: "CLEANER",
    staffNumber: String(seq),
    displayName: `スタッフ${String(seq)}`,
    locale: "ja",
    isActive: true,
    ...overrides,
  };
}

function ledgerFor(personRow: OrgStaff, overrides: Partial<StaffLedgerRow> = {}): StaffLedgerRow {
  return {
    id: `${ORG}__sppf_${personRow.membershipId.slice(-4)}`,
    membershipId: personRow.membershipId,
    hiredOn: null,
    resignedOn: null,
    workStatus: "TRAINING",
    languages: [],
    skills: [],
    note: null,
    ...overrides,
  };
}

function program(id: string, overrides: Partial<TrainingProgramRow> = {}): TrainingProgramRow {
  return {
    id: `${ORG}__trpg_${id}`,
    name: "清掃の基本手順",
    expectedMinutes: 240,
    languages: ["ja"],
    sortOrder: 1,
    isActive: true,
    ...overrides,
  };
}

function record(
  membershipId: string,
  programId: string,
  overrides: Partial<TrainingRecordRow> = {},
): TrainingRecordRow {
  return {
    id: `${ORG}__trrc_${programId.slice(-4)}`,
    membershipId,
    programId: `${ORG}__trpg_${programId}`,
    completedOn: "2026-08-10",
    mentorMembershipId: null,
    ...overrides,
  };
}

function cert(membershipId: string, expiresOn: string | null): CertificationRow {
  return {
    id: `${ORG}__cert_${String(seq)}`,
    membershipId,
    name: "衛生管理者講習",
    expiresOn,
    note: null,
  };
}

describe("buildTrainingPage — 研修中のスタッフ", () => {
  it("進捗が「修了数 / 有効な項目数」で出る", () => {
    const trainee = person();
    const page = buildTrainingPage({
      staff: [trainee],
      ledger: [ledgerFor(trainee)],
      programs: [program("A"), program("B"), program("C")],
      records: [record(trainee.membershipId, "A")],
      certifications: [],
      businessDate: TODAY,
    });
    expect(page.trainees[0]).toMatchObject({ completed: 1, total: 3 });
    expect(page.summary.inTraining).toBe(1);
  });

  it("**無効化したプログラムを分母に入れない**（過去の項目で進捗が縮まない）", () => {
    const trainee = person();
    const page = buildTrainingPage({
      staff: [trainee],
      ledger: [ledgerFor(trainee)],
      programs: [program("A"), program("B", { isActive: false })],
      records: [record(trainee.membershipId, "B")],
      certifications: [],
      businessDate: TODAY,
    });
    // 無効な B の修了は数えず、分母も A の 1 つだけ。
    expect(page.trainees[0]).toMatchObject({ completed: 0, total: 1 });
  });

  it("直近の修了の同行者が名前で出る", () => {
    const trainee = person();
    const mentor = person();
    const page = buildTrainingPage({
      staff: [trainee, mentor],
      ledger: [ledgerFor(trainee)],
      programs: [program("A"), program("B")],
      records: [
        record(trainee.membershipId, "A", { completedOn: "2026-08-01" }),
        record(trainee.membershipId, "B", {
          completedOn: "2026-08-15",
          mentorMembershipId: mentor.membershipId,
        }),
      ],
      certifications: [],
      businessDate: TODAY,
    });
    expect(page.trainees[0]?.mentorName).toBe(mentor.displayName);
  });

  it("稼働中のスタッフは研修中の表に出ない", () => {
    const worker = person();
    const page = buildTrainingPage({
      staff: [worker],
      ledger: [ledgerFor(worker, { workStatus: "ACTIVE" })],
      programs: [program("A")],
      records: [],
      certifications: [],
      businessDate: TODAY,
    });
    expect(page.trainees).toHaveLength(0);
  });

  it("**点数・順位・速さの項目が無い**（security.md §5）", () => {
    const trainee = person();
    const page = buildTrainingPage({
      staff: [trainee],
      ledger: [ledgerFor(trainee)],
      programs: [program("A")],
      records: [record(trainee.membershipId, "A")],
      certifications: [],
      businessDate: TODAY,
    });
    const keys = Object.keys(page.trainees[0] ?? {});
    for (const forbidden of ["score", "rank", "speed", "minutes", "duration"]) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden)), forbidden).toBe(false);
    }
  });
});

describe("buildTrainingPage — 今月完了と資格", () => {
  it("今月完了は業務日の月で数える", () => {
    const trainee = person();
    const page = buildTrainingPage({
      staff: [trainee],
      ledger: [],
      programs: [program("A"), program("B")],
      records: [
        record(trainee.membershipId, "A", { completedOn: "2026-08-05" }),
        record(trainee.membershipId, "B", { completedOn: "2026-07-30" }),
      ],
      certifications: [],
      businessDate: TODAY,
    });
    expect(page.summary.completedThisMonth).toBe(1);
  });

  it("期限 60 日以内は「更新必要」", () => {
    const holder = person();
    const page = buildTrainingPage({
      staff: [holder],
      ledger: [],
      programs: [],
      records: [],
      certifications: [cert(holder.membershipId, "2026-09-30")],
      businessDate: TODAY,
    });
    expect(page.certifications[0]?.needsRenewal).toBe(true);
    expect(page.summary.needsRenewal).toBe(1);
  });

  it("期限が 60 日より先なら「有効」", () => {
    const holder = person();
    const page = buildTrainingPage({
      staff: [holder],
      ledger: [],
      programs: [],
      records: [],
      certifications: [cert(holder.membershipId, "2027-03-11")],
      businessDate: TODAY,
    });
    expect(page.certifications[0]?.needsRenewal).toBe(false);
  });

  it("期限の無い資格は「有効」のまま", () => {
    const holder = person();
    const page = buildTrainingPage({
      staff: [holder],
      ledger: [],
      programs: [],
      records: [],
      certifications: [cert(holder.membershipId, null)],
      businessDate: TODAY,
    });
    expect(page.certifications[0]?.needsRenewal).toBe(false);
  });
});

describe("DEFAULT_TRAINING_PROGRAMS", () => {
  it("プロトタイプの 6 項目（文言そのまま）", () => {
    expect(DEFAULT_TRAINING_PROGRAMS.map((program) => program.name)).toEqual([
      "アプリの操作",
      "清掃の基本手順",
      "浴室・水回りの手順",
      "リネンの取り扱い",
      "衛生と安全",
      "記録の入力実習",
    ]);
  });
});
