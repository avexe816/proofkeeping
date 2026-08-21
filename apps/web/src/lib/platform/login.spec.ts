/**
 * プラットフォーム運営のログイン（PF-01）。
 *
 * ── リポジトリ層を差し替える理由 ────────────────────────
 * ここで確かめたいのは「どの失敗も同じ結果になるか」「ロックの数え方」
 * 「記録が残るか」であって SQL ではない。SQL の分離は
 * `packages/db/src/repositories/platform.spec.ts` が走査で固定している。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const findPlatformOperatorByEmail = vi.fn();
const recordPlatformLoginAttempt = vi.fn();
const recordPlatformAudit = vi.fn();

vi.mock("@pk/db", () => ({
  findPlatformOperatorByEmail: (...args: unknown[]) =>
    findPlatformOperatorByEmail(...args) as unknown,
  recordPlatformLoginAttempt: (...args: unknown[]) =>
    recordPlatformLoginAttempt(...args) as unknown,
  recordPlatformAudit: (...args: unknown[]) => recordPlatformAudit(...args) as unknown,
}));

const { hashPassword } = await import("../auth/password.js");
const { PLATFORM_LOCK_POLICY, platformLogin } = await import("./login.js");
const { PLATFORM_SESSION_COOKIE_NAME, PLATFORM_SESSION_TTL_SECONDS, readPlatformSession } =
  await import("./session.js");
const { createFakeKv } = await import("../auth/test-support/fake-kv.js");

type Env = import("@pk/db").Env;
type FakeKv = import("../auth/test-support/fake-kv.js").FakeKv;

const OPERATOR_ID = "plat_op_01JBXQ3ZK8N4P2VYR60000";
const EMAIL = "ops@stek.ai";
const PASSWORD = "Correct1Horse";
const NOW = new Date("2026-08-20T09:00:00.000Z");

let passwordHash = "";
let kv: FakeKv;
let env: Env;

/** `platform_operator` 行の代役。認証が見る列だけを持たせる。 */
function operatorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OPERATOR_ID,
    email: EMAIL,
    displayName: "運営 太郎",
    passwordHash,
    status: "ACTIVE",
    failedAttempts: 0,
    lockedUntil: null,
    // PF-17。既定は TOTP 登録済みの担当者。
    // 封筒のスタブ（このテストは復号しない）。DB には平文を置かない（#244）。
    twoFactorSecret: "pk2fa$v1$stub$stub",
    twoFactorConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
    twoFactorFailedAttempts: 0,
    twoFactorLockedUntil: null,
    twoFactorLastStep: null,
    ...overrides,
  };
}

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(() => {
  vi.clearAllMocks();
  kv = createFakeKv();
  env = { SESSION: kv.namespace, SESSION_SECRET: "test-secret" } as unknown as Env;
  findPlatformOperatorByEmail.mockResolvedValue(operatorRow());
  recordPlatformLoginAttempt.mockResolvedValue(undefined);
  recordPlatformAudit.mockResolvedValue(undefined);
});

describe("成功", () => {
  it("セッションを発行し、Cookie 値を返す", async () => {
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operatorId).toBe(OPERATOR_ID);
    expect(result.session.cookieValue).toContain(".");
    // **テナントの `sess:` と別の接頭辞に置く**（DECISIONS #220 の 3）。
    expect([...kv.store.keys()].every((key) => key.startsWith("plat:"))).toBe(true);
  });

  it("発行したセッションを読み戻せる", async () => {
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const record = await readPlatformSession(env, result.session.cookieValue, NOW);
    expect(record?.operatorId).toBe(OPERATOR_ID);
  });

  it("失敗回数を消す", async () => {
    await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    expect(recordPlatformLoginAttempt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ operatorId: OPERATOR_ID, success: true }),
    );
  });

  it("**`platform.login` はまだ書かない**（成立は第 2 要素 / PF-17）", async () => {
    await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW, ip: "203.0.113.9" });
    expect(recordPlatformAudit).not.toHaveBeenCalledWith(
      env,
      expect.objectContaining({ action: "platform.login" }),
    );
  });

  it("発行されるのはパスワード段階の札（PASSWORD_ONLY / PF-17）", async () => {
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.record.state).toBe("PASSWORD_ONLY");
    // TOTP 登録済みなので登録画面へは送らない。
    expect(result.requiresEnrollment).toBe(false);
  });

  it("TOTP 未登録なら requiresEnrollment が立つ（PF-17）", async () => {
    findPlatformOperatorByEmail.mockResolvedValue(
      operatorRow({ twoFactorSecret: null, twoFactorConfirmedAt: null }),
    );
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requiresEnrollment).toBe(true);
  });
});

describe("失敗の応答を一律にする（security.md §2）", () => {
  it.each([
    [
      "メールが存在しない",
      () => {
        findPlatformOperatorByEmail.mockResolvedValue(null);
      },
      PASSWORD,
    ],
    [
      "パスワードが違う",
      () => {
        /* 既定のまま */
      },
      "Wrong1Password",
    ],
    [
      "ロック中",
      () => {
        findPlatformOperatorByEmail.mockResolvedValue(
          operatorRow({ lockedUntil: new Date(NOW.getTime() + 60_000) }),
        );
      },
      PASSWORD,
    ],
    [
      "無効化済み",
      () => {
        findPlatformOperatorByEmail.mockResolvedValue(operatorRow({ status: "SUSPENDED" }));
      },
      PASSWORD,
    ],
    [
      "ロック中かつパスワードも違う",
      () => {
        findPlatformOperatorByEmail.mockResolvedValue(
          operatorRow({ lockedUntil: new Date(NOW.getTime() + 60_000) }),
        );
      },
      "Wrong1Password",
    ],
  ])("%s でも AUTH_FAILED 1 種類", async (_name, arrange, password) => {
    arrange();
    const result = await platformLogin(env, { email: EMAIL, password, now: NOW });

    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
    // **セッションを作らない。**
    expect(kv.store.size).toBe(0);
  });

  it("ロックが切れていれば通る", async () => {
    findPlatformOperatorByEmail.mockResolvedValue(
      operatorRow({ lockedUntil: new Date(NOW.getTime() - 1) }),
    );
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe("失敗の記録", () => {
  it("パスワード違いは失敗として数える", async () => {
    await platformLogin(env, { email: EMAIL, password: "Wrong1Password", now: NOW });
    expect(recordPlatformLoginAttempt).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        operatorId: OPERATOR_ID,
        success: false,
        maxAttempts: PLATFORM_LOCK_POLICY.maxFailures,
        lockMs: PLATFORM_LOCK_POLICY.lockSeconds * 1000,
      }),
    );
  });

  it("**毎回**記録する（テナント面の 5 回目だけとは違う）", async () => {
    await platformLogin(env, { email: EMAIL, password: "Wrong1Password", now: NOW });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ action: "platform.login.failed" }),
    );
  });

  it("存在しないメールでは数えない（数える相手がいない）", async () => {
    findPlatformOperatorByEmail.mockResolvedValue(null);
    await platformLogin(env, { email: "nobody@example.com", password: PASSWORD, now: NOW });
    expect(recordPlatformLoginAttempt).not.toHaveBeenCalled();
    expect(recordPlatformAudit).not.toHaveBeenCalled();
  });

  it("記録に失敗しても認証の応答を変えない", async () => {
    recordPlatformAudit.mockRejectedValue(new Error("kv down"));
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe("Cookie 名", () => {
  it("テナントの `pk_session` と別名（DECISIONS #220 の 3）", () => {
    expect(PLATFORM_SESSION_COOKIE_NAME).toBe("pk_plat_session");
  });
});

/**
 * 第 2 要素を要求しない環境（PF-19 / DECISIONS #250）。
 *
 * **ここがログインの成立点になる。** 札は `COMPLETE`、寿命は 2FA を
 * 通ったときと同じ 12 時間、監査は `platform.login` を 1 本。
 */
describe("PLATFORM_2FA_REQUIRED=false（staging）", () => {
  beforeEach(() => {
    env = {
      SESSION: kv.namespace,
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "staging",
      PLATFORM_2FA_REQUIRED: "false",
    } as unknown as Env;
  });

  it("**`COMPLETE` の札を出す**（第 2 要素へ送らない）", async () => {
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.record.state).toBe("COMPLETE");
    expect(result.secondFactorRequired).toBe(false);
  });

  it("**寿命は既存の `COMPLETE` と同じ 12 時間**（別の長さを作らない）", async () => {
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    if (!result.ok) return;
    expect(result.session.maxAgeSeconds).toBe(PLATFORM_SESSION_TTL_SECONDS);
  });

  it("**TOTP 未登録でも `COMPLETE`**（登録済みと同じ扱い / 要件 5）", async () => {
    findPlatformOperatorByEmail.mockResolvedValue(
      operatorRow({ twoFactorSecret: null, twoFactorConfirmedAt: null }),
    );
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    if (!result.ok) return;
    expect(result.session.record.state).toBe("COMPLETE");
  });

  it("**`platform.login` を書き、要求しなかったことを残す**（要件 6）", async () => {
    await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW, ip: "203.0.113.9" });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        action: "platform.login",
        detail: { secondFactor: "NONE", twoFactorRequired: false },
      }),
    );
  });

  it("**監査に secret も TOTP も復旧コードも入れない**", async () => {
    await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    const written = JSON.stringify(
      recordPlatformAudit.mock.calls.map((call) => call[1] as unknown),
    );
    expect(written).not.toContain("pk2fa$");
    expect(written).not.toContain(PASSWORD);
    for (const key of ["twoFactorSecret", "recoveryCode", "totp", "secretKey"]) {
      expect(written).not.toContain(key);
    }
  });

  it("パスワードが違えば通らない（要求しない ≠ 認証しない）", async () => {
    const result = await platformLogin(env, { email: EMAIL, password: "wrong-password", now: NOW });
    expect(result).toEqual({ ok: false, reason: "AUTH_FAILED" });
  });

  it("**production では `false` を書いても `PASSWORD_ONLY`**", async () => {
    env = {
      SESSION: kv.namespace,
      SESSION_SECRET: "test-secret",
      ENVIRONMENT: "production",
      PLATFORM_2FA_REQUIRED: "false",
    } as unknown as Env;
    const result = await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW });
    if (!result.ok) return;
    expect(result.session.record.state).toBe("PASSWORD_ONLY");
    expect(result.secondFactorRequired).toBe(true);
  });
});
