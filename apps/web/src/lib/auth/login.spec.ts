/**
 * パスワードログインのユースケース（P0-08）。
 *
 * ── リポジトリ層を差し替える理由 ────────────────────────
 * ここで確かめたいのは「どの失敗も同じ結果になるか」「ロックの数え方」
 * 「ロールごとの認証方式」であって、SQL ではない。SQL に組織条件が載ることは
 * `packages/db/src/repositories/repositories.spec.ts` が全関数について
 * 固定しているので、ここでは重ねない。
 */

import type { Role } from "@pk/db";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const lookupOrganizationId = vi.fn();
const findUserByStaffNumber = vi.fn();
const findMembershipByUserId = vi.fn();
const recordLoginAttempt = vi.fn();
const recordAudit = vi.fn();

vi.mock("@pk/db", () => ({
  lookupOrganizationId: (...args: unknown[]) => lookupOrganizationId(...args) as unknown,
  findUserByStaffNumber: (...args: unknown[]) => findUserByStaffNumber(...args) as unknown,
  findMembershipByUserId: (...args: unknown[]) => findMembershipByUserId(...args) as unknown,
  recordLoginAttempt: (...args: unknown[]) => recordLoginAttempt(...args) as unknown,
  recordAudit: (...args: unknown[]) => recordAudit(...args) as unknown,
}));

const { hashPassword } = await import("./password.js");
const { PASSWORD_FAILURE_AUDIT_AT, PASSWORD_LOCK_POLICY, login } = await import("./login.js");
const { createFakeKv } = await import("./test-support/fake-kv.js");

type Env = import("@pk/db").Env;
type FakeKv = import("./test-support/fake-kv.js").FakeKv;

const ORG = { organizationId: "org_test_alpha", orgShortId: "a1b2c3" } as const;
const USER_ID = "a1b2c3__usr_01JBXQ3ZK8N4P2VYR60000";
const MEMBERSHIP_ID = "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000";
const NOW = new Date("2026-08-11T09:00:00.000Z");
const PASSWORD = "Correct1Horse";

let passwordHash = "";
let kv: FakeKv;
let env: Env;

/** `user` 行の代役。認証が見る列だけを持たせる。 */
function userRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: USER_ID,
    organizationId: ORG.organizationId,
    staffNumber: "S-0001",
    passwordHash,
    pinHash: null,
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    ...overrides,
  };
}

function membershipRow(role: Role = "ORG_ADMIN", isActive = true): Record<string, unknown> {
  return { id: MEMBERSHIP_ID, organizationId: ORG.organizationId, role, isActive };
}

function credentials(overrides: Partial<{ password: string }> = {}) {
  return {
    orgShortId: ORG.orgShortId,
    staffNumber: "S-0001",
    password: overrides.password ?? PASSWORD,
  };
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.clearAllMocks();
  kv = createFakeKv();
  env = { SESSION: kv.namespace, SESSION_SECRET: "test-secret" } as unknown as Env;
  lookupOrganizationId.mockResolvedValue(ORG.organizationId);
  findUserByStaffNumber.mockResolvedValue(userRow());
  findMembershipByUserId.mockResolvedValue(membershipRow());
  recordLoginAttempt.mockResolvedValue(undefined);
  recordAudit.mockResolvedValue(undefined);
});

describe("成功", () => {
  it("セッションを発行し、Cookie 値を返す", async () => {
    const result = await login(env, { credentials: credentials(), now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.cookieValue).not.toBe("");
    expect(kv.store.size).toBe(1);
  });

  it("セッションは membershipId を持つ（P0-10 が TenantContext を組み立てる材料）", async () => {
    const result = await login(env, { credentials: credentials(), now: NOW });
    expect(result.ok && result.session.record.membershipId).toBe(MEMBERSHIP_ID);
  });

  it("失敗回数を 0 に戻し、ロックを解除し、最終ログイン時刻を入れる", async () => {
    findUserByStaffNumber.mockResolvedValue(userRow({ failedLoginCount: 4 }));
    await login(env, { credentials: credentials(), now: NOW });
    expect(recordLoginAttempt).toHaveBeenCalledWith(env, expect.anything(), {
      userId: USER_ID,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: NOW,
      now: NOW,
    });
  });

  it("組織はセッションから解決した値を使う（リクエストの値を信用しない）", async () => {
    const result = await login(env, { credentials: credentials(), now: NOW });
    expect(result.ok && result.session.record.organizationId).toBe(ORG.organizationId);
    expect(lookupOrganizationId).toHaveBeenCalledWith(env, ORG.orgShortId);
  });

  it.each<Role>(["OWNER", "ORG_ADMIN", "PROPERTY_MANAGER", "VENDOR_ADMIN", "AUDITOR"])(
    "管理系ロール（%s）はパスワードでログインできる",
    async (role) => {
      findMembershipByUserId.mockResolvedValue(membershipRow(role));
      const result = await login(env, { credentials: credentials(), now: NOW });
      expect(result.ok).toBe(true);
    },
  );
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
      "パスワードが未設定（現場系）",
      () => {
        findUserByStaffNumber.mockResolvedValue(userRow({ passwordHash: null }));
      },
    ],
    [
      "無効化されたユーザー",
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
      "所属が無効",
      () => {
        findMembershipByUserId.mockResolvedValue(membershipRow("ORG_ADMIN", false));
      },
    ],
  ])("%s でも AUTH_FAILED のみを返し、セッションを作らない", async (_label, arrange) => {
    arrange();
    const result = await login(env, { credentials: credentials(), now: NOW });
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
    expect(kv.store.size).toBe(0);
  });

  it("パスワードが違えば AUTH_FAILED", async () => {
    const result = await login(env, {
      credentials: credentials({ password: "Wrong1Password" }),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
    expect(kv.store.size).toBe(0);
  });

  it("現場系ロール（CLEANER / INSPECTOR）はパスワードでログインできない", async () => {
    // 通すと 16 時間ではなく 12 時間側の期限が付き、認証方式と期限の対応が崩れる。
    for (const role of ["CLEANER", "INSPECTOR"] as const) {
      findMembershipByUserId.mockResolvedValue(membershipRow(role));
      const result = await login(env, { credentials: credentials(), now: NOW });
      expect(result, role).toEqual({ ok: false, reason: "AUTH_FAILED" });
    }
  });
});

describe("存在の推測を防ぐ", () => {
  it("組織が無いときも DB を引かず、パスワードの検証時間だけは使う", async () => {
    lookupOrganizationId.mockResolvedValue(null);
    await login(env, { credentials: credentials(), now: NOW });
    expect(findUserByStaffNumber).not.toHaveBeenCalled();
  });

  it("該当が無いときに失敗回数を書かない（存在しない行は更新できない）", async () => {
    findUserByStaffNumber.mockResolvedValue(undefined);
    await login(env, { credentials: credentials(), now: NOW });
    expect(recordLoginAttempt).not.toHaveBeenCalled();
  });
});

describe("アカウントロック", () => {
  it("security.md §2 の方針である（10 回で 30 分）", () => {
    expect(PASSWORD_LOCK_POLICY.maxFailures).toBe(10);
    expect(PASSWORD_LOCK_POLICY.lockSeconds).toBe(30 * 60);
  });

  it("失敗のたびに 1 ずつ増える", async () => {
    findUserByStaffNumber.mockResolvedValue(userRow({ failedLoginCount: 3 }));
    await login(env, { credentials: credentials({ password: "Wrong1Password" }), now: NOW });
    expect(recordLoginAttempt).toHaveBeenCalledWith(env, expect.anything(), {
      userId: USER_ID,
      failedLoginCount: 4,
      lockedUntil: null,
      now: NOW,
    });
  });

  it("9 回目まではロックしない", async () => {
    findUserByStaffNumber.mockResolvedValue(userRow({ failedLoginCount: 8 }));
    await login(env, { credentials: credentials({ password: "Wrong1Password" }), now: NOW });
    expect(recordLoginAttempt).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({ failedLoginCount: 9, lockedUntil: null }),
    );
  });

  it("10 回目でロックし、カウンタを 0 に戻す", async () => {
    findUserByStaffNumber.mockResolvedValue(userRow({ failedLoginCount: 9 }));
    await login(env, { credentials: credentials({ password: "Wrong1Password" }), now: NOW });
    expect(recordLoginAttempt).toHaveBeenCalledWith(env, expect.anything(), {
      userId: USER_ID,
      failedLoginCount: 0,
      lockedUntil: new Date(NOW.getTime() + PASSWORD_LOCK_POLICY.lockSeconds * 1000),
      now: NOW,
    });
  });

  it("ロック中は正しいパスワードでも通さない", async () => {
    findUserByStaffNumber.mockResolvedValue(
      userRow({ lockedUntil: new Date(NOW.getTime() + 1) }),
    );
    const result = await login(env, { credentials: credentials(), now: NOW });
    expect(result.ok).toBe(false);
  });

  it("ロック中の失敗で数え上げない（総当たりでロックを延長させない）", async () => {
    findUserByStaffNumber.mockResolvedValue(
      userRow({ failedLoginCount: 5, lockedUntil: new Date(NOW.getTime() + 60_000) }),
    );
    await login(env, { credentials: credentials({ password: "Wrong1Password" }), now: NOW });
    expect(recordLoginAttempt).not.toHaveBeenCalled();
  });

  it("ロックが切れていれば正しいパスワードで通る", async () => {
    findUserByStaffNumber.mockResolvedValue(
      userRow({ failedLoginCount: 0, lockedUntil: new Date(NOW.getTime() - 1) }),
    );
    const result = await login(env, { credentials: credentials(), now: NOW });
    expect(result.ok).toBe(true);
  });

  it("ロックが切れていたら失敗回数を数え直す", async () => {
    findUserByStaffNumber.mockResolvedValue(
      userRow({ failedLoginCount: 9, lockedUntil: new Date(NOW.getTime() - 1) }),
    );
    await login(env, { credentials: credentials({ password: "Wrong1Password" }), now: NOW });
    expect(recordLoginAttempt).toHaveBeenCalledWith(env, expect.anything(), {
      userId: USER_ID,
      failedLoginCount: 1,
      lockedUntil: null,
      now: NOW,
    });
  });
});

describe("ログイン失敗の監査ログ（P0-11）", () => {
  /** `failedLoginCount` が n の状態から 1 回失敗させる。 */
  async function failOnceFrom(failedLoginCount: number, ip?: string) {
    findUserByStaffNumber.mockResolvedValue(userRow({ failedLoginCount }));
    return login(env, {
      credentials: credentials({ password: "WrongPassword1" }),
      now: NOW,
      ...(ip === undefined ? {} : { ip }),
    });
  }

  it("5 回目の失敗で 1 件だけ書く", async () => {
    // security.md §6「ログイン失敗（5 回目のみ）」。
    await failOnceFrom(PASSWORD_FAILURE_AUDIT_AT - 1);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const input = recordAudit.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input["action"]).toBe("auth.loginFailed");
    expect(input["actorId"]).toBe(MEMBERSHIP_ID);
    expect(input["targetId"]).toBe(USER_ID);
  });

  it.each([0, 1, 3, 5, 8])("%s 回目からの失敗（5 回目以外）では書かない", async (count) => {
    await failOnceFrom(count);
    const expected = count + 1 === PASSWORD_FAILURE_AUDIT_AT ? 1 : 0;
    expect(recordAudit).toHaveBeenCalledTimes(expected);
  });

  it("ロックの閾値（10 回）では書かない", async () => {
    // 5 と 10 は別の数字。ロックに合わせて動かさない。
    await failOnceFrom(PASSWORD_LOCK_POLICY.maxFailures - 1);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("IP を渡せば監査ログに載る", async () => {
    await failOnceFrom(PASSWORD_FAILURE_AUDIT_AT - 1, "203.0.113.7");
    const input = recordAudit.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input["ip"]).toBe("203.0.113.7");
  });

  it("actorRole は membership のロールから入る", async () => {
    findMembershipByUserId.mockResolvedValue(membershipRow("PROPERTY_MANAGER"));
    await failOnceFrom(PASSWORD_FAILURE_AUDIT_AT - 1);
    const ctx = recordAudit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(ctx["role"]).toBe("PROPERTY_MANAGER");
    expect(ctx["organizationId"]).toBe(ORG.organizationId);
    expect(ctx["now"]).toBe(NOW);
  });

  it("所属が無いユーザーでは書かない（誰の操作か決められない）", async () => {
    findMembershipByUserId.mockResolvedValue(undefined);
    await failOnceFrom(PASSWORD_FAILURE_AUDIT_AT - 1);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("監査ログの書き込みが失敗しても応答は AUTH_FAILED のまま", async () => {
    // ここで 500 になると、失敗の理由が応答から読める。
    recordAudit.mockRejectedValue(new Error("D1_UNAVAILABLE"));
    const result = await failOnceFrom(PASSWORD_FAILURE_AUDIT_AT - 1);
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it("ログイン成功では書かない", async () => {
    await login(env, { credentials: credentials(), now: NOW });
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("ロック中の失敗では数え上げず、書かない", async () => {
    findUserByStaffNumber.mockResolvedValue(
      userRow({
        failedLoginCount: PASSWORD_FAILURE_AUDIT_AT - 1,
        lockedUntil: new Date(NOW.getTime() + 60_000),
      }),
    );
    await login(env, { credentials: credentials({ password: "WrongPassword1" }), now: NOW });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
