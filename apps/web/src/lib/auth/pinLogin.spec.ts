/**
 * PIN ログインのユースケース（P0-09）。
 *
 * ── リポジトリ層を差し替える理由 ────────────────────────
 * ここで確かめたいのは「どの失敗も同じ結果になるか」「ロールごとの認証方式」
 * 「失敗を数えていないこと」であって、SQL ではない。SQL に組織条件が載ることは
 * `packages/db/src/repositories/repositories.spec.ts` が全関数について
 * 固定しているので、ここでは重ねない（`login.spec.ts` と同じ方針）。
 */

import type { Role } from "@pk/db";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const lookupOrganizationId = vi.fn();
const findUserByStaffNumber = vi.fn();
const findMembershipByUserId = vi.fn();
const recordLoginAttempt = vi.fn();

vi.mock("@pk/db", () => ({
  lookupOrganizationId: (...args: unknown[]) => lookupOrganizationId(...args) as unknown,
  findUserByStaffNumber: (...args: unknown[]) => findUserByStaffNumber(...args) as unknown,
  findMembershipByUserId: (...args: unknown[]) => findMembershipByUserId(...args) as unknown,
  recordLoginAttempt: (...args: unknown[]) => recordLoginAttempt(...args) as unknown,
}));

const { hashPin } = await import("./pin.js");
const { pinLogin } = await import("./pinLogin.js");
const { SESSION_TTL_SECONDS } = await import("./session.js");
const { createFakeKv } = await import("./test-support/fake-kv.js");

type Env = import("@pk/db").Env;
type FakeKv = import("./test-support/fake-kv.js").FakeKv;

const ORG = { organizationId: "org_test_alpha", orgShortId: "a1b2c3" } as const;
const USER_ID = "a1b2c3__usr_01JBXQ3ZK8N4P2VYR60000";
const MEMBERSHIP_ID = "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000";
const NOW = new Date("2026-08-12T09:00:00.000Z");
const PIN = "8261";

let pinHash = "";
let kv: FakeKv;
let env: Env;

/** `user` 行の代役。認証が見る列だけを持たせる。 */
function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    organizationId: ORG.organizationId,
    staffNumber: "S-0001",
    passwordHash: null,
    pinHash,
    pinMustChange: false,
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    ...overrides,
  };
}

function membershipRow(role: Role = "CLEANER", isActive = true): Record<string, unknown> {
  return { id: MEMBERSHIP_ID, organizationId: ORG.organizationId, role, isActive };
}

function credentials(overrides: Partial<{ pin: string }> = {}) {
  return {
    orgShortId: ORG.orgShortId,
    staffNumber: "S-0001",
    pin: overrides.pin ?? PIN,
  };
}

beforeAll(async () => {
  pinHash = await hashPin(PIN);
});

beforeEach(() => {
  vi.clearAllMocks();
  kv = createFakeKv();
  env = { SESSION: kv.namespace, SESSION_SECRET: "test-secret" } as unknown as Env;
  lookupOrganizationId.mockResolvedValue(ORG.organizationId);
  findUserByStaffNumber.mockResolvedValue(userRow());
  findMembershipByUserId.mockResolvedValue(membershipRow());
  recordLoginAttempt.mockResolvedValue(undefined);
});

describe("成功", () => {
  it("セッションを発行し、Cookie 値を返す", async () => {
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.cookieValue).not.toBe("");
    expect(kv.store.size).toBe(1);
  });

  it("セッションの認証方式は PIN", async () => {
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok && result.session.record.authMethod).toBe("PIN");
  });

  it("有効期限は 16 時間（1 勤務）", async () => {
    // 管理系の 12 時間と混ざらないこと。ロールと有効期限は対応している。
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok && result.session.maxAgeSeconds).toBe(16 * 60 * 60);
    expect(result.ok && result.session.record.expiresAt).toBe(
      NOW.getTime() + SESSION_TTL_SECONDS.PIN * 1000,
    );
  });

  it("セッションは membershipId を持つ（P0-10 が TenantContext を組み立てる材料）", async () => {
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok && result.session.record.membershipId).toBe(MEMBERSHIP_ID);
  });

  it("組織はリクエストの値ではなく org_directory から解決した値を使う", async () => {
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok && result.session.record.organizationId).toBe(ORG.organizationId);
    expect(lookupOrganizationId).toHaveBeenCalledWith(env, ORG.orgShortId);
  });

  it("最終ログイン時刻を入れる", async () => {
    await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(recordLoginAttempt).toHaveBeenCalledWith(env, expect.anything(), {
      userId: USER_ID,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: NOW,
      now: NOW,
    });
  });

  it.each<Role>(["CLEANER", "INSPECTOR"])("現場系ロール（%s）は PIN でログインできる", async (role) => {
    findMembershipByUserId.mockResolvedValue(membershipRow(role));
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok).toBe(true);
  });

  it("pinMustChange をそのまま返す（初回変更の判定材料）", async () => {
    findUserByStaffNumber.mockResolvedValue(userRow({ pinMustChange: true }));
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok && result.pinMustChange).toBe(true);
  });
});

describe("失敗はすべて同じ結果になる", () => {
  it.each([
    [
      "組織が存在しない",
      () => {
        lookupOrganizationId.mockResolvedValue(null);
      },
    ],
    [
      "スタッフ番号が存在しない",
      () => {
        findUserByStaffNumber.mockResolvedValue(undefined);
      },
    ],
    [
      "PIN が設定されていない",
      () => {
        findUserByStaffNumber.mockResolvedValue(userRow({ pinHash: null }));
      },
    ],
    [
      "ユーザーが無効化されている",
      () => {
        findUserByStaffNumber.mockResolvedValue(userRow({ isActive: false }));
      },
    ],
    [
      "ロック中",
      () => {
        findUserByStaffNumber.mockResolvedValue(
          userRow({ lockedUntil: new Date(NOW.getTime() + 60_000) }),
        );
      },
    ],
    [
      "所属が無い",
      () => {
        findMembershipByUserId.mockResolvedValue(undefined);
      },
    ],
    [
      "所属が無効化されている",
      () => {
        findMembershipByUserId.mockResolvedValue(membershipRow("CLEANER", false));
      },
    ],
  ])("%s", async (_label, arrange) => {
    arrange();
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    // 理由を分けない。区別できるとアカウントの存在が推測できる（security.md §2）。
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
    expect(kv.store.size).toBe(0);
  });

  it("PIN が違えば落とす", async () => {
    const result = await pinLogin(env, { credentials: credentials({ pin: "8262" }), now: NOW });
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it.each<Role>(["OWNER", "ORG_ADMIN", "PROPERTY_MANAGER", "VENDOR_ADMIN", "AUDITOR"])(
    "管理系ロール（%s）は PIN でログインできない",
    async (role) => {
      // 4 桁の認証情報で 16 時間のセッションを持たせない。
      findMembershipByUserId.mockResolvedValue(membershipRow(role));
      const result = await pinLogin(env, { credentials: credentials(), now: NOW });
      expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
    },
  );

  it("切れたロックは通す（引きずらない）", async () => {
    findUserByStaffNumber.mockResolvedValue(
      userRow({ lockedUntil: new Date(NOW.getTime() - 1_000) }),
    );
    const result = await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe("失敗を数えない（P0-09 のスコープ外）", () => {
  // security.md §2 の「5 回失敗で 15 分ロック」は P0-09 では実装していない。
  // 総当たりを止めているのはレート制限（20 req/分/IP）。
  // `failedLoginCount` 列をパスワードと共有しているため、中途半端に数えると
  // 「PIN の失敗でパスワードがロックされる」が起きる。
  it("PIN 相違で recordLoginAttempt を呼ばない", async () => {
    await pinLogin(env, { credentials: credentials({ pin: "8262" }), now: NOW });
    expect(recordLoginAttempt).not.toHaveBeenCalled();
  });

  it("何度失敗しても failedLoginCount を書き換えない", async () => {
    findUserByStaffNumber.mockResolvedValue(userRow({ failedLoginCount: 4 }));
    for (let i = 0; i < 6; i++) {
      await pinLogin(env, { credentials: credentials({ pin: "0000" }), now: NOW });
    }
    expect(recordLoginAttempt).not.toHaveBeenCalled();
  });

  it("存在しないユーザーでも書き込みが起きない", async () => {
    findUserByStaffNumber.mockResolvedValue(undefined);
    await pinLogin(env, { credentials: credentials(), now: NOW });
    expect(recordLoginAttempt).not.toHaveBeenCalled();
  });
});
