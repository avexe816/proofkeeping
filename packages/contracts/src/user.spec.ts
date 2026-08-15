/**
 * 現場スタッフの登録スキーマ（P7-01 / PK-SPEC-P7 §2.3 Step 5）。
 *
 * **`ROLES` との包含はここで見られない。** `packages/contracts` は
 * `packages/db` に依存しない（依存の向きが逆になる）。両方を import できる
 * `apps/web/src/routes/api/v1/users.spec.ts` が突き合わせている。
 */

import { describe, expect, it } from "vitest";

import { FIELD_STAFF_ROLES, fieldStaffCreateSchema } from "./user.js";

const PROPERTY_ID = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

function body(overrides: Record<string, unknown> = {}): unknown {
  return {
    displayName: "清掃 花子",
    staffNumber: "S-0042",
    role: "CLEANER",
    propertyIds: [PROPERTY_ID],
    ...overrides,
  };
}

describe("fieldStaffCreateSchema", () => {
  it("最小の形が通る", () => {
    expect(fieldStaffCreateSchema.safeParse(body()).success).toBe(true);
  });

  it("**PIN を受け取らない**（送っても結果に現れない）", () => {
    const parsed = fieldStaffCreateSchema.parse(body({ pin: "2580" }));
    expect("pin" in parsed).toBe(false);
  });

  it("現場系の 2 ロールだけを受ける", () => {
    for (const role of FIELD_STAFF_ROLES) {
      expect(fieldStaffCreateSchema.safeParse(body({ role })).success).toBe(true);
    }
    for (const role of ["OWNER", "ORG_ADMIN", "PROPERTY_MANAGER", "VENDOR_ADMIN", "AUDITOR"]) {
      expect(fieldStaffCreateSchema.safeParse(body({ role })).success).toBe(false);
    }
  });

  it("**担当施設は 1 つ以上**（無いとタスクが 1 件も出ない）", () => {
    expect(fieldStaffCreateSchema.safeParse(body({ propertyIds: [] })).success).toBe(false);
    expect(fieldStaffCreateSchema.safeParse(body({ propertyIds: [PROPERTY_ID] })).success).toBe(
      true,
    );
  });

  it("表示名は空にできない。前後の空白は落とす", () => {
    expect(fieldStaffCreateSchema.safeParse(body({ displayName: "   " })).success).toBe(false);
    expect(fieldStaffCreateSchema.parse(body({ displayName: " 花子 " })).displayName).toBe("花子");
  });

  it("スタッフ番号は `staffNumberSchema` の規則に従う（大文字小文字を変えない）", () => {
    expect(fieldStaffCreateSchema.safeParse(body({ staffNumber: "スタッフ" })).success).toBe(false);
    expect(fieldStaffCreateSchema.safeParse(body({ staffNumber: "" })).success).toBe(false);
    expect(fieldStaffCreateSchema.parse(body({ staffNumber: "S-abC" })).staffNumber).toBe("S-abC");
  });

  it("メールは任意。形が違えば通さない", () => {
    expect(fieldStaffCreateSchema.parse(body()).email).toBeUndefined();
    expect(fieldStaffCreateSchema.safeParse(body({ email: "not-an-email" })).success).toBe(false);
    expect(fieldStaffCreateSchema.safeParse(body({ email: "a@example.com" })).success).toBe(true);
  });

  it("表示言語は ja / en だけ", () => {
    expect(fieldStaffCreateSchema.safeParse(body({ locale: "ja" })).success).toBe(true);
    expect(fieldStaffCreateSchema.safeParse(body({ locale: "en" })).success).toBe(true);
    expect(fieldStaffCreateSchema.safeParse(body({ locale: "fr" })).success).toBe(false);
  });
});
