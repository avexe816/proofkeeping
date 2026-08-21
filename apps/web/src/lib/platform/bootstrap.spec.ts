/**
 * 初期開通（PF-16）。**1 人目だけ・1 回だけ。**
 *
 * task: docs/tasks/PF-16.md
 * 決定: docs/DECISIONS.md #240・#245
 *
 * ── リポジトリ層を「原子的な 1 文」として差し替える ──────
 * `platform.ts` の 2 つ（券の消費・1 人目の INSERT）は、**条件の検査と
 * 書き込みが 1 文の中で終わる**ことを前提に書いてある。ここではその性質を
 * 持つ代役（検査と書き込みの間に await を挟まない）を注入して、
 * **同時に走らせたときに 1 本しか通らない**ことを確かめる。
 *
 * 代役が原子的でなければ、この spec は「実装が読んで書いている」ことを
 * 捕まえられない。**代役の中に await を足さないこと。**
 * 発行される SQL が実際に条件付きであることは
 * `packages/db/src/repositories/platform.spec.ts` が別に押さえている。
 *
 * ── 秘密の非露出は走査で固定する ────────────────────────
 * `recordPlatformAudit` へ渡った全引数を JSON にし、**開通 token と
 * パスワードの平文が一切含まれない**ことを毎ケース確かめる（要件 10）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 代役の中身。テストから直接覗く。 */
interface FakeRow {
  id: string;
  email: string;
  displayName: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

const store = {
  operators: [] as { id: string; email: string; passwordHash: string }[],
  tokens: [] as FakeRow[],
};

const recordPlatformAudit = vi.fn();

/**
 * **1 文で終わる代役。** `await` を挟まない（挟むと原子性が消え、
 * 実装の誤りを捕まえられなくなる — このファイル冒頭の注記）。
 */
vi.mock("@pk/db", () => ({
  recordPlatformAudit: (...args: unknown[]) => recordPlatformAudit(...args) as unknown,
  platformOperatorExists: () => Promise.resolve(store.operators.length > 0),
  createFirstPlatformOperator: (
    _env: unknown,
    input: { id: string; email: string; passwordHash: string },
  ) => {
    // `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM platform_operator)`。
    if (store.operators.length > 0) return Promise.resolve(false);
    store.operators.push({ id: input.id, email: input.email, passwordHash: input.passwordHash });
    return Promise.resolve(true);
  },
  createPlatformBootstrapToken: (_env: unknown, input: Omit<FakeRow, "usedAt" | "revokedAt">) => {
    store.tokens.push({ ...input, usedAt: null, revokedAt: null });
    return Promise.resolve();
  },
  findActivePlatformBootstrapToken: (
    _env: unknown,
    input: { tokenHash: string; now: Date },
  ) => {
    const row = store.tokens.find(
      (t) =>
        t.tokenHash === input.tokenHash &&
        t.usedAt === null &&
        t.revokedAt === null &&
        t.expiresAt.getTime() > input.now.getTime(),
    );
    return Promise.resolve(row ?? null);
  },
  consumePlatformBootstrapToken: (_env: unknown, input: { tokenHash: string; now: Date }) => {
    // 有効条件を WHERE に畳み込んだ UPDATE。**1 本だけが true を得る。**
    const row = store.tokens.find(
      (t) =>
        t.tokenHash === input.tokenHash &&
        t.usedAt === null &&
        t.revokedAt === null &&
        t.expiresAt.getTime() > input.now.getTime(),
    );
    if (row === undefined) return Promise.resolve(false);
    row.usedAt = input.now;
    return Promise.resolve(true);
  },
  revokePlatformBootstrapTokens: (_env: unknown, now: Date) => {
    for (const row of store.tokens) {
      if (row.usedAt === null && row.revokedAt === null) row.revokedAt = now;
    }
    return Promise.resolve();
  },
}));

const {
  BOOTSTRAP_TOKEN_TTL_SECONDS,
  activatePlatformBootstrap,
  buildBootstrapLink,
  findBootstrapInvitation,
  issuePlatformBootstrap,
} = await import("./bootstrap.js");
const { sha256HexOfText } = await import("../evidence/hash.js");
const { createFakeKv } = await import("../auth/test-support/fake-kv.js");
const { verifyPassword } = await import("../auth/password.js");

type Env = import("@pk/db").Env;

const NOW = new Date("2026-08-21T09:00:00.000Z");
const EMAIL = "ops@stek.ai";
const NAME = "運営 太郎";
/** 規約（10 文字以上・英大小・数字）を満たす値。**実在の秘密ではない。** */
const PASSWORD = "Bootstrap2026x";

let env: Env;
/** Resend への送信。既定は成功。 */
let fetchMock: ReturnType<typeof vi.fn>;

/** 監査へ渡った全引数の JSON。**秘密の非露出をここで走査する。** */
function auditJson(): string {
  return JSON.stringify(recordPlatformAudit.mock.calls);
}

function auditActions(): string[] {
  return recordPlatformAudit.mock.calls.map((call) => (call[1] as { action: string }).action);
}

/** 送ったメール本文（1 通目）。 */
function sentMailBody(): string {
  const call = fetchMock.mock.calls[0];
  const init = call?.[1] as { body?: string } | undefined;
  return init?.body ?? "";
}

/** 発行してリンクの token を取り出す（**テストの中でだけ触れる**）。 */
async function issueAndCaptureToken(at: Date = NOW): Promise<string> {
  const result = await issuePlatformBootstrap(env, { email: EMAIL, displayName: NAME, now: at });
  expect(result.ok).toBe(true);
  const match = /\/plat\/bootstrap\/([A-Za-z0-9_-]+)/.exec(sentMailBody());
  if (match?.[1] === undefined) throw new Error("link not sent");
  fetchMock.mockClear();
  return match[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  store.operators = [];
  store.tokens = [];
  recordPlatformAudit.mockResolvedValue(undefined);
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

afterEach(() => {
  vi.unstubAllGlobals();
  // **どのケースでも**パスワードの平文が監査へ漏れていないこと（要件 10）。
  expect(auditJson()).not.toContain(PASSWORD);
});

describe("発行（issuePlatformBootstrap）", () => {
  it("券を 1 枚作り、開通リンクをメールで 1 回だけ渡す", async () => {
    const result = await issuePlatformBootstrap(env, {
      email: EMAIL,
      displayName: NAME,
      now: NOW,
    });

    expect(result).toEqual({
      ok: true,
      expiresAt: new Date(NOW.getTime() + BOOTSTRAP_TOKEN_TTL_SECONDS * 1000),
    });
    expect(store.tokens).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
    expect(sentMailBody()).toContain("/plat/bootstrap/");
    // **運営担当者はまだ作らない**（既定パスワードを持つ行を作らないため）。
    expect(store.operators).toEqual([]);
  });

  it("DB に平文の token を置かない（ハッシュだけ）", async () => {
    const token = await issueAndCaptureToken();
    const row = store.tokens[0];
    expect(row?.tokenHash).toBe(await sha256HexOfText(token));
    expect(JSON.stringify(store.tokens)).not.toContain(token);
  });

  it("token も開通リンクもメールアドレスも監査ログに出さない（要件 10）", async () => {
    const token = await issueAndCaptureToken();
    const json = auditJson();
    expect(json).not.toContain(token);
    expect(json).not.toContain("/plat/bootstrap/");
    expect(json).not.toContain(EMAIL);
    expect(auditActions()).toContain("platform.bootstrap.issued");
  });

  it("運営担当者が 1 名でも居れば拒否する（要件 8）", async () => {
    store.operators.push({ id: "plat_op_existing", email: "someone@stek.ai", passwordHash: "x" });

    const result = await issuePlatformBootstrap(env, {
      email: EMAIL,
      displayName: NAME,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: "OPERATOR_EXISTS" });
    expect(store.tokens).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditActions()).toContain("platform.bootstrap.rejected");
  });

  it("メールを送れない環境では券を作らない（ログ出力へ倒さない）", async () => {
    env = { ...env, RESEND_API_KEY: "" };

    const result = await issuePlatformBootstrap(env, {
      email: EMAIL,
      displayName: NAME,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: "DELIVERY_UNAVAILABLE" });
    expect(store.tokens).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("送信に失敗したら券を失効させる", async () => {
    fetchMock.mockResolvedValue({ ok: false });

    const result = await issuePlatformBootstrap(env, {
      email: EMAIL,
      displayName: NAME,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: "DELIVERY_FAILED" });
    expect(store.tokens).toHaveLength(1);
    expect(store.tokens[0]?.revokedAt).not.toBeNull();
    expect(auditActions()).toContain("platform.bootstrap.delivery_failed");
  });

  it("再発行すると前の券は使えなくなる（有効なリンクは常に 1 本以下）", async () => {
    const first = await issueAndCaptureToken();
    const second = await issueAndCaptureToken(new Date(NOW.getTime() + 60_000));

    expect(await findBootstrapInvitation(env, { token: first, now: NOW })).toBeNull();
    expect(await findBootstrapInvitation(env, { token: second, now: NOW })).not.toBeNull();
  });

  it("開通リンクは APP_BASE_URL の下に出る", () => {
    expect(buildBootstrapLink({ APP_BASE_URL: "https://x.example/" }, "abc")).toBe(
      "https://x.example/plat/bootstrap/abc",
    );
  });
});

describe("開通（activatePlatformBootstrap）", () => {
  it("パスワードを設定し、運営担当者を 1 名だけ作る", async () => {
    const token = await issueAndCaptureToken();

    const result = await activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW });

    expect(result.ok).toBe(true);
    expect(store.operators).toHaveLength(1);
    expect(store.operators[0]?.email).toBe(EMAIL);
    // **保存されるのはハッシュだけ。** 平文の列を作らない。
    expect(store.operators[0]?.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, store.operators[0]?.passwordHash ?? "")).toBe(true);
    expect(auditActions()).toContain("platform.bootstrap.completed");
  });

  it("発行するのはパスワード段階の札（2FA を通るまで運営画面へ入れない）", async () => {
    const token = await issueAndCaptureToken();

    const result = await activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW });

    expect(result.ok && result.session.record.state).toBe("PASSWORD_ONLY");
    // 10 分（`PLATFORM_PENDING_TTL_SECONDS`）。12 時間の札を出さない。
    expect(result.ok && result.session.maxAgeSeconds).toBe(10 * 60);
  });

  it("同じ token の 2 回目は通らない（1 回使用で失効）", async () => {
    const token = await issueAndCaptureToken();
    await activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW });

    const second = await activatePlatformBootstrap(env, {
      token,
      password: PASSWORD,
      now: NOW,
    });

    expect(second).toEqual({ ok: false, reason: "REJECTED" });
    expect(store.operators).toHaveLength(1);
  });

  it("期限切れ・使用済み・不正 token の応答が同じ（要件）", async () => {
    const expired = await issueAndCaptureToken();
    const afterExpiry = new Date(NOW.getTime() + (BOOTSTRAP_TOKEN_TTL_SECONDS + 1) * 1000);

    const used = await issueAndCaptureToken(new Date(NOW.getTime() + 1000));
    await activatePlatformBootstrap(env, { token: used, password: PASSWORD, now: NOW });
    store.operators = []; // 使用済み token だけを見たいので担当者は戻す

    const results = [
      await activatePlatformBootstrap(env, {
        token: expired,
        password: PASSWORD,
        now: afterExpiry,
      }),
      await activatePlatformBootstrap(env, { token: used, password: PASSWORD, now: NOW }),
      await activatePlatformBootstrap(env, {
        token: "not-a-real-token",
        password: PASSWORD,
        now: NOW,
      }),
    ];

    expect(results).toEqual([
      { ok: false, reason: "REJECTED" },
      { ok: false, reason: "REJECTED" },
      { ok: false, reason: "REJECTED" },
    ]);
  });

  it("規約を満たさないパスワードでは券を消費しない（やり直せる）", async () => {
    const token = await issueAndCaptureToken();

    const weak = await activatePlatformBootstrap(env, { token, password: "short", now: NOW });

    expect(weak).toEqual({ ok: false, reason: "POLICY_VIOLATION" });
    expect(store.tokens[0]?.usedAt).toBeNull();
    // 直したら通る。
    expect((await activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW })).ok).toBe(
      true,
    );
  });

  it("GET 相当（findBootstrapInvitation）では券を消費しない", async () => {
    const token = await issueAndCaptureToken();

    expect(await findBootstrapInvitation(env, { token, now: NOW })).toEqual({
      email: EMAIL,
      displayName: NAME,
    });
    expect(store.tokens[0]?.usedAt).toBeNull();
    expect((await activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW })).ok).toBe(
      true,
    );
  });

  it("token を監査ログへ出さない（要件 10）", async () => {
    const token = await issueAndCaptureToken();
    await activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW });
    expect(auditJson()).not.toContain(token);
  });
});

describe("同時実行（DB 側の保証）", () => {
  it("同じ token を 20 本同時に使っても 1 本だけ成功する", async () => {
    const token = await issueAndCaptureToken();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        activatePlatformBootstrap(env, { token, password: PASSWORD, now: NOW }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(store.operators).toHaveLength(1);
  });

  it("別々の有効な券から同時に開通しても運営担当者は 1 名だけ", async () => {
    // 券を 2 枚（**通常は再発行で 1 枚に絞られる**が、その保証に頼らない）。
    const first = await issueAndCaptureToken();
    const second = await issueAndCaptureToken(new Date(NOW.getTime() + 1000));
    // 再発行が 1 枚目を失効させているので、ここだけ戻して 2 枚とも生かす。
    for (const row of store.tokens) row.revokedAt = null;

    const results = await Promise.all([
      activatePlatformBootstrap(env, { token: first, password: PASSWORD, now: NOW }),
      activatePlatformBootstrap(env, { token: second, password: PASSWORD, now: NOW }),
    ]);

    expect(store.operators).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(auditJson()).toContain("OPERATOR_EXISTS");
  });
});
