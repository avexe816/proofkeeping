/**
 * 運営画面の門（PF-01 / PF-17）。
 *
 * PF-17 の完了条件「TOTP を登録していない運営担当者がログイン後の画面へ
 * 到達できない」をここで固定する。**門は 404 で、理由を返さない。**
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findPlatformOperatorById = vi.fn();

vi.mock("@pk/db", () => ({
  findPlatformOperatorById: (...args: unknown[]) => findPlatformOperatorById(...args) as unknown,
}));

const { requirePlatformOperator, requirePlatformSecondFactorStage } = await import(
  "./requireOperator.js"
);
const { createPlatformSession, PLATFORM_SESSION_COOKIE_NAME } = await import("./session.js");
const { createFakeKv } = await import("../auth/test-support/fake-kv.js");

type Env = import("@pk/db").Env;
type FakeKv = import("../auth/test-support/fake-kv.js").FakeKv;

const OPERATOR_ID = "plat_op_01JBXQ3ZK8N4P2VYR60000";
const NOW = new Date("2026-08-21T09:00:00.000Z");

let kv: FakeKv;
let env: Env;

function operatorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OPERATOR_ID,
    email: "ops@stek.ai",
    displayName: "運営 太郎",
    passwordHash: "pbkdf2$sha256$5000$x$y",
    status: "ACTIVE",
    failedAttempts: 0,
    lockedUntil: null,
    // 封筒のスタブ（このテストは復号しない）。DB には平文を置かない（#244）。
    twoFactorSecret: "pk2fa$v1$stub$stub",
    twoFactorConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
    twoFactorFailedAttempts: 0,
    twoFactorLockedUntil: null,
    twoFactorLastStep: null,
    ...overrides,
  };
}

async function requestWith(state: "PASSWORD_ONLY" | "COMPLETE"): Promise<Request> {
  const session = await createPlatformSession(env, { operatorId: OPERATOR_ID, state, now: NOW });
  return new Request("https://example.com/plat/status", {
    headers: { Cookie: `${PLATFORM_SESSION_COOKIE_NAME}=${session.cookieValue}` },
  });
}

async function statusOf(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  kv = createFakeKv();
  env = {
    SESSION: kv.namespace,
    SESSION_SECRET: "test-secret",
  } as unknown as Env;
  findPlatformOperatorById.mockResolvedValue(operatorRow());
});

describe("requirePlatformOperator（ログイン後の門）", () => {
  it("COMPLETE の札で通る", async () => {
    const context = await requirePlatformOperator(env, await requestWith("COMPLETE"), NOW);
    expect(context.operatorId).toBe(OPERATOR_ID);
  });

  it("**パスワード段階の札では 404**（第 2 要素を通っていない / PF-17）", async () => {
    expect(await statusOf(requirePlatformOperator(env, await requestWith("PASSWORD_ONLY"), NOW))).toBe(
      404,
    );
  });

  it("**TOTP 未登録の担当者は COMPLETE の札でも 404**（完了条件）", async () => {
    findPlatformOperatorById.mockResolvedValue(operatorRow({ twoFactorConfirmedAt: null }));
    expect(await statusOf(requirePlatformOperator(env, await requestWith("COMPLETE"), NOW))).toBe(
      404,
    );
  });

  it("セッションが無ければ 404", async () => {
    const request = new Request("https://example.com/plat/status");
    expect(await statusOf(requirePlatformOperator(env, request, NOW))).toBe(404);
  });

  it("**v1（PF-01 形式）の札は無効**（2FA を経ていない札を生かさない）", async () => {
    // 正しい v2 の札を出してから、KV の中身だけ旧形式（v1）へ差し替える。
    // 版上げ前に発行されたセッションが版上げ後に生き残らないことの再現。
    const session = await createPlatformSession(env, {
      operatorId: OPERATOR_ID,
      state: "COMPLETE",
      now: NOW,
    });
    const v1Record = JSON.stringify({
      v: 1,
      operatorId: OPERATOR_ID,
      issuedAt: NOW.getTime(),
      expiresAt: NOW.getTime() + 60_000,
    });
    for (const key of [...kv.store.keys()]) kv.seed(key, v1Record);

    const request = new Request("https://example.com/plat/status", {
      headers: { Cookie: `${PLATFORM_SESSION_COOKIE_NAME}=${session.cookieValue}` },
    });
    expect(await statusOf(requirePlatformOperator(env, request, NOW))).toBe(404);
  });
});

describe("requirePlatformSecondFactorStage（第 2 要素の画面の門）", () => {
  it("パスワード段階の札で担当者の行が返る", async () => {
    const stage = await requirePlatformSecondFactorStage(
      env,
      await requestWith("PASSWORD_ONLY"),
      NOW,
    );
    expect(stage?.operator.id).toBe(OPERATOR_ID);
  });

  it("COMPLETE の札では null（もう入り終わっている）", async () => {
    expect(
      await requirePlatformSecondFactorStage(env, await requestWith("COMPLETE"), NOW),
    ).toBeNull();
  });

  it("札が無ければ 404（画面の存在を教えない）", async () => {
    const request = new Request("https://example.com/plat/2fa");
    expect(await statusOf(requirePlatformSecondFactorStage(env, request, NOW))).toBe(404);
  });

  it("無効化済みの担当者は 404", async () => {
    findPlatformOperatorById.mockResolvedValue(operatorRow({ status: "SUSPENDED" }));
    expect(
      await statusOf(requirePlatformSecondFactorStage(env, await requestWith("PASSWORD_ONLY"), NOW)),
    ).toBe(404);
  });
});
