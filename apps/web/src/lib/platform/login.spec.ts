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
const { PLATFORM_SESSION_COOKIE_NAME, readPlatformSession } = await import("./session.js");
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

  it("成功も記録に残る", async () => {
    await platformLogin(env, { email: EMAIL, password: PASSWORD, now: NOW, ip: "203.0.113.9" });
    expect(recordPlatformAudit).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ action: "platform.login", ip: "203.0.113.9" }),
    );
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
