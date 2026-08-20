/**
 * Workforce のスキーマ（P8-01 / P8-02）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例）/ security.md §3
 *
 * ── ここが見るのは 3 つ ─────────────────────────────────
 *   1. 期限を要する種別で空欄を通さない（通すとアラートから静かに外れる）
 *   2. 更新の申請日が期限より後になっていない
 *   3. **持たないと決めた項目を受け取らない**（在留カード番号など）
 */

import { describe, expect, it } from "vitest";

import {
  residencyUpsertRequestSchema,
  shiftUpsertRequestSchema,
  staffLedgerUpdateRequestSchema,
} from "./workforce.js";

const STAFF = "a1b2c3__sppf_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const MEMBER = "a1b2c3__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

function residency(overrides: Record<string, unknown> = {}) {
  return residencyUpsertRequestSchema.safeParse({
    staffProfileId: STAFF,
    statusType: "SPECIFIED_SKILLED_1",
    expiresOn: "2026-11-30",
    workPermitRequired: false,
    ...overrides,
  });
}

describe("residencyUpsertRequestSchema — 正例", () => {
  it("特定技能 1 号に期限があれば通る", () => {
    expect(residency().success).toBe(true);
  });

  it("永住者は期限が無くても通る", () => {
    expect(residency({ statusType: "PERMANENT", expiresOn: null }).success).toBe(true);
  });

  it("日本国籍は期限が無くても通る", () => {
    expect(residency({ statusType: "NOT_APPLICABLE", expiresOn: null }).success).toBe(true);
  });

  it("更新の申請日が期限より前なら通る", () => {
    expect(residency({ renewalAppliedOn: "2026-10-01" }).success).toBe(true);
  });

  it("留学の週上限 28 時間が通る", () => {
    const parsed = residency({ statusType: "STUDENT_PART_TIME", weeklyHourLimit: 28 });
    expect(parsed.success).toBe(true);
  });
});

describe("residencyUpsertRequestSchema — 負例", () => {
  it("**期限を要する種別で空欄を通さない**（アラートから静かに外れる）", () => {
    const parsed = residency({ expiresOn: null });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("EXPIRES_ON_REQUIRED");
  });

  it("技能実習でも空欄を通さない", () => {
    const parsed = residency({ statusType: "TRAINING_EMPLOYMENT", expiresOn: null });
    expect(parsed.success).toBe(false);
  });

  it("更新の申請日が期限より後なら通さない", () => {
    const parsed = residency({ expiresOn: "2026-10-01", renewalAppliedOn: "2026-11-30" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("RENEWAL_AFTER_EXPIRY");
  });

  it("別組織の ID を通さない形式（`resourceIdSchema`）", () => {
    expect(residency({ staffProfileId: "not-an-id" }).success).toBe(false);
  });

  it("週上限が 168 時間を超えたら通さない", () => {
    expect(residency({ weeklyHourLimit: 200 }).success).toBe(false);
  });

  it("知らない種別を通さない", () => {
    expect(residency({ statusType: "REFUGEE" }).success).toBe(false);
  });
});

describe("持たないと決めた項目を受け取らない（security.md §3）", () => {
  const FORBIDDEN = {
    residenceCardNumber: "AB1234567890",
    passportNumber: "TR1234567",
    address: "東京都…",
    birthDate: "1995-04-01",
    nationality: "VN",
    bankAccountNumber: "1234567",
    myNumber: "123456789012",
  };

  it.each(Object.entries(FORBIDDEN))("`%s` を渡しても保持しない", (key, value) => {
    const parsed = residency({ [key]: value });
    // Zod の既定は未知のキーを**落とす**（`strict()` ではない）。
    // 通ったとしても、値がデータに残らないことをここで固定する。
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty(key);
  });

  it("就労可否を受け取らない（仕様 §1.4 MUST）", () => {
    const parsed = residency({ canWork: true });
    expect(parsed.data).not.toHaveProperty("canWork");
  });
});

describe("staffLedgerUpdateRequestSchema", () => {
  it("渡した項目だけで通る（部分更新）", () => {
    const parsed = staffLedgerUpdateRequestSchema.safeParse({
      membershipId: MEMBER,
      workStatus: "TRAINING",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("languages");
  });

  it("言語は 10 件まで", () => {
    const parsed = staffLedgerUpdateRequestSchema.safeParse({
      membershipId: MEMBER,
      languages: Array.from({ length: 11 }, () => "ja"),
    });
    expect(parsed.success).toBe(false);
  });

  it("単価を受け取らない（`payRule` が持つ / DECISIONS #221）", () => {
    const parsed = staffLedgerUpdateRequestSchema.safeParse({
      membershipId: MEMBER,
      hourlyRate: 1500,
    });
    expect(parsed.data).not.toHaveProperty("hourlyRate");
  });

  it("知らない就業状態を通さない", () => {
    const parsed = staffLedgerUpdateRequestSchema.safeParse({
      membershipId: MEMBER,
      workStatus: "FIRED",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("shiftUpsertRequestSchema（P8-03）", () => {
  const base = {
    membershipId: MEMBER,
    businessDate: "2026-08-20",
    shiftType: "WORK",
    propertyId: "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  };

  it("出勤（WORK）＋施設で通る", () => {
    const parsed = shiftUpsertRequestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.breakMinutes).toBe(60);
  });

  it("休みは施設なしで通る", () => {
    const parsed = shiftUpsertRequestSchema.safeParse({
      ...base,
      shiftType: "OFF",
      propertyId: null,
    });
    expect(parsed.success).toBe(true);
  });

  // ── 負例 ──────────────────────────────────────────────

  it("**WORK に施設が無ければ弾く**（出勤者数が静かに狂う）", () => {
    const parsed = shiftUpsertRequestSchema.safeParse({ ...base, propertyId: null });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("PROPERTY_REQUIRED");
  });

  it("**休みに施設が付いていれば弾く**", () => {
    const parsed = shiftUpsertRequestSchema.safeParse({ ...base, shiftType: "OFF" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("PROPERTY_NOT_ALLOWED");
  });

  it("知らない区分を通さない", () => {
    const parsed = shiftUpsertRequestSchema.safeParse({ ...base, shiftType: "OVERTIME" });
    expect(parsed.success).toBe(false);
  });

  it("時刻の形（HH:MM）以外を通さない", () => {
    const parsed = shiftUpsertRequestSchema.safeParse({ ...base, startAt: "9時" });
    expect(parsed.success).toBe(false);
  });

  it("打刻の項目（clockIn など）を受け取らない（DECISIONS #221）", () => {
    const parsed = shiftUpsertRequestSchema.safeParse({ ...base, clockInAt: "09:02" });
    expect(parsed.data).not.toHaveProperty("clockInAt");
  });
});
