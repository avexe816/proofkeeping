/**
 * 開通したばかりの担当者が**どこまで入れるか**（PF-16 の要件 6・7）。
 *
 * task: docs/tasks/PF-16.md
 * 決定: docs/DECISIONS.md #240（5「初回ログインでパスワード設定と 2FA 登録を
 *       必須」）・#243（セッションの 2 段階）
 *
 * ── 何を確かめるか ──────────────────────────────────────
 * パスワードを決めただけの状態で `/plat/*` に到達できないこと。
 * `bootstrap.spec.ts` が「札の種類が `PASSWORD_ONLY` である」ところまでを
 * 見るのに対し、ここは**その札を実際に門へ通して 404 を受け取る**まで。
 * 札の種類と門の判定は別のファイルにあり、片方だけ直すと穴が開く。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeToken {
  id: string;
  email: string;
  displayName: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

const store = {
  operators: [] as {
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    status: string;
    twoFactorConfirmedAt: Date | null;
  }[],
  tokens: [] as FakeToken[],
};

vi.mock("@pk/db", () => ({
  recordPlatformAudit: () => Promise.resolve(),
  platformOperatorExists: () => Promise.resolve(store.operators.length > 0),
  createFirstPlatformOperator: (
    _env: unknown,
    input: { id: string; email: string; displayName: string; passwordHash: string },
  ) => {
    if (store.operators.length > 0) return Promise.resolve(false);
    store.operators.push({
      ...input,
      status: "ACTIVE",
      // **開通の時点では未登録。** ここが `null` である限り門は 404 を返す。
      twoFactorConfirmedAt: null,
    });
    return Promise.resolve(true);
  },
  findPlatformOperatorById: (_env: unknown, id: string) =>
    Promise.resolve(
      store.operators.find((operator) => operator.id === id) === undefined
        ? null
        : {
            ...store.operators.find((operator) => operator.id === id),
            failedAttempts: 0,
            lockedUntil: null,
            twoFactorSecret: null,
            twoFactorFailedAttempts: 0,
            twoFactorLockedUntil: null,
            twoFactorLastStep: null,
          },
    ),
  createPlatformBootstrapToken: (_env: unknown, input: Omit<FakeToken, "usedAt" | "revokedAt">) => {
    store.tokens.push({ ...input, usedAt: null, revokedAt: null });
    return Promise.resolve();
  },
  findActivePlatformBootstrapToken: (_env: unknown, input: { tokenHash: string; now: Date }) =>
    Promise.resolve(
      store.tokens.find(
        (row) =>
          row.tokenHash === input.tokenHash &&
          row.usedAt === null &&
          row.revokedAt === null &&
          row.expiresAt.getTime() > input.now.getTime(),
      ) ?? null,
    ),
  consumePlatformBootstrapToken: (_env: unknown, input: { tokenHash: string; now: Date }) => {
    const row = store.tokens.find(
      (candidate) =>
        candidate.tokenHash === input.tokenHash &&
        candidate.usedAt === null &&
        candidate.revokedAt === null &&
        candidate.expiresAt.getTime() > input.now.getTime(),
    );
    if (row === undefined) return Promise.resolve(false);
    row.usedAt = input.now;
    return Promise.resolve(true);
  },
  revokePlatformBootstrapTokens: () => Promise.resolve(),
}));

const { activatePlatformBootstrap, issuePlatformBootstrap } = await import("./bootstrap.js");
const { requirePlatformOperator, requirePlatformSecondFactorStage } = await import(
  "./requireOperator.js"
);
const { PLATFORM_SESSION_COOKIE_NAME } = await import("./session.js");
const { createFakeKv } = await import("../auth/test-support/fake-kv.js");

type Env = import("@pk/db").Env;

const NOW = new Date("2026-08-21T09:00:00.000Z");
const EMAIL = "ops@stek.ai";
const PASSWORD = "Bootstrap2026x";

let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

/** 発行 → 開通 まで通し、出来上がった Cookie の値を返す。 */
async function activateAndGetCookie(): Promise<string> {
  await issuePlatformBootstrap(env, { email: EMAIL, displayName: "運営 太郎", now: NOW });
  const body = (fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined)?.body ?? "";
  const token = /\/plat\/bootstrap\/([A-Za-z0-9_-]+)/.exec(body)?.[1];
  if (token === undefined) throw new Error("link not sent");

  const result = await activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW });
  if (!result.ok) throw new Error("activation failed");
  return result.session.cookieValue;
}

function requestWith(cookieValue: string, path: string): Request {
  return new Request(`https://example.com${path}`, {
    headers: { Cookie: `${PLATFORM_SESSION_COOKIE_NAME}=${cookieValue}` },
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
  store.operators = [];
  store.tokens = [];
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  env = {
    SESSION: createFakeKv().namespace,
    SESSION_SECRET: "test-secret",
    APP_BASE_URL: "https://plat.example.invalid",
    RESEND_API_KEY: "re_test_key",
    RESEND_FROM_ADDRESS: "noreply@example.invalid",
  } as unknown as Env;
});

describe("開通の直後（パスワードだけ決めた状態）", () => {
  it("**`/plat/*` へ到達できない**（2FA 登録が終わるまで 404 / 要件 7）", async () => {
    const cookieValue = await activateAndGetCookie();

    expect(
      await statusOf(
        requirePlatformOperator(env, requestWith(cookieValue, "/plat/status"), NOW),
      ),
    ).toBe(404);
  });

  it("2 要素認証の登録画面には入れる（そこへ進ませるための札）", async () => {
    const cookieValue = await activateAndGetCookie();

    const stage = await requirePlatformSecondFactorStage(
      env,
      requestWith(cookieValue, "/plat/2fa/setup"),
      NOW,
    );

    expect(stage?.operator.email).toBe(EMAIL);
    // **未登録のまま作られている**（初回ログインで登録を通るのが正 / PF-17）。
    expect(stage?.operator.twoFactorConfirmedAt).toBeNull();
  });

  it("**登録が済むまでは何度読み直しても 404**（札の期限内でも変わらない）", async () => {
    const cookieValue = await activateAndGetCookie();
    const later = new Date(NOW.getTime() + 5 * 60 * 1000);

    expect(
      await statusOf(
        requirePlatformOperator(env, requestWith(cookieValue, "/plat/status"), later),
      ),
    ).toBe(404);
  });

  it("**2FA の登録が済むと通る**（門が見ているのはそこだけ）", async () => {
    const cookieValue = await activateAndGetCookie();
    // PF-17 の `confirmPlatformTwoFactor()` が入る状態を作る。札も
    // `COMPLETE` へ載せ替わる（`confirmTotpEnrollment()` の担当）。
    const operator = store.operators[0];
    if (operator !== undefined) operator.twoFactorConfirmedAt = NOW;
    const { createPlatformSession } = await import("./session.js");
    const complete = await createPlatformSession(env, {
      operatorId: operator?.id ?? "",
      state: "COMPLETE",
      now: NOW,
    });

    const context = await requirePlatformOperator(
      env,
      requestWith(complete.cookieValue, "/plat/status"),
      NOW,
    );

    expect(context.email).toBe(EMAIL);
    expect(cookieValue).not.toBe(complete.cookieValue);
  });
});
