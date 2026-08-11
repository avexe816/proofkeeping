/**
 * 認証 API のハンドラ（P0-08）。ステータスコードと Cookie の写像。
 *
 * 認証の判定そのものは `lib/auth/login.spec.ts` が見る。ここで確かめるのは
 * 「どの失敗も 401 で理由が 1 種類か」「レート制限が 429 になるか」
 * 「Cookie の属性が落ちていないか」。
 */

import { loginResponseSchema } from "@pk/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { hashPassword } = await import("../../../lib/auth/password.js");
const { RATE_LIMITS } = await import("../../../lib/auth/rateLimit.js");
const { createFakeKv } = await import("../../../lib/auth/test-support/fake-kv.js");
const auth = (await import("./auth.js")).default;

type Env = import("@pk/db").Env;
type FakeKv = import("../../../lib/auth/test-support/fake-kv.js").FakeKv;

const ORG = { organizationId: "org_test_alpha", orgShortId: "a1b2c3" } as const;
const PASSWORD = "Correct1Horse";
const IP = "203.0.113.10";

let sessionKv: FakeKv;
let rateLimitKv: FakeKv;
let env: Env;
let passwordHash = "";

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return auth.request(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (passwordHash === "") passwordHash = await hashPassword(PASSWORD);

  sessionKv = createFakeKv();
  rateLimitKv = createFakeKv();
  env = {
    SESSION: sessionKv.namespace,
    RATELIMIT: rateLimitKv.namespace,
    SESSION_SECRET: "test-secret",
  } as unknown as Env;

  lookupOrganizationId.mockResolvedValue(ORG.organizationId);
  findUserByStaffNumber.mockResolvedValue({
    id: "a1b2c3__usr_01JBXQ3ZK8N4P2VYR60000",
    organizationId: ORG.organizationId,
    staffNumber: "S-0001",
    passwordHash,
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
  });
  findMembershipByUserId.mockResolvedValue({
    id: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000",
    organizationId: ORG.organizationId,
    role: "ORG_ADMIN",
    isActive: true,
  });
  recordLoginAttempt.mockResolvedValue(undefined);
});

describe("POST /login", () => {
  it("成功すると 200 と expiresAt を返す", async () => {
    const response = await post({
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    // 契約（packages/contracts）どおりの形で返ること。
    const body = loginResponseSchema.parse(await response.json());
    // 12 時間後。ISO 8601 で返す。
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("成功すると security.md §2 の属性を持つ Cookie を返す", async () => {
    const response = await post({
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: PASSWORD,
    });
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("pk_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=43200");
  });

  it("本体にセッション ID を入れない（httpOnly の意味を消さない）", async () => {
    const response = await post({
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: PASSWORD,
    });
    const body: unknown = await response.json();
    expect(Object.keys(body as Record<string, unknown>)).toEqual(["expiresAt"]);
  });

  it("認証に失敗すると 401 と AUTH_FAILED のみ", async () => {
    const response = await post({
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: "Wrong1Password",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_FAILED" });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("組織が存在しなくても同じ 401 AUTH_FAILED", async () => {
    // 404 や別コードにすると組織の存在が分かる。
    lookupOrganizationId.mockResolvedValue(null);
    const response = await post({
      orgShortId: "zzzzzz",
      staffNumber: "S-0001",
      password: PASSWORD,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_FAILED" });
  });

  it.each([
    ["項目が足りない", { orgShortId: "a1b2c3" }],
    ["orgShortId の桁数が違う", { orgShortId: "a1b2", staffNumber: "S-0001", password: PASSWORD }],
    [
      "スタッフ番号が空",
      { orgShortId: "a1b2c3", staffNumber: "", password: PASSWORD },
    ],
    ["パスワードが空", { orgShortId: "a1b2c3", staffNumber: "S-0001", password: "" }],
    ["本体が JSON でない", "not json"],
  ])("入力の形が違えば 400（%s）", async (_label, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
  });

  it("ログインのポリシーを入力検査に混ぜない（短いパスワードも 401 で返す）", async () => {
    // 400 と 401 が分かれると、パスワードの形が推測できる。
    const response = await post({
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: "short",
    });
    expect(response.status).toBe(401);
  });

  it("11 回目のリクエストは 429 と Retry-After", async () => {
    const credentials = {
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: "Wrong1Password",
    };
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      const response = await post(credentials);
      expect(response.status, `${String(i + 1)} 回目`).toBe(401);
    }
    const limited = await post(credentials);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "RATE_LIMITED" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("レート制限に掛かったら認証まで進まない", async () => {
    const credentials = {
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: PASSWORD,
    };
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) await post(credentials);
    vi.clearAllMocks();
    await post(credentials);
    expect(lookupOrganizationId).not.toHaveBeenCalled();
  });
});

describe("POST /logout", () => {
  async function logout(headers: Record<string, string> = {}): Promise<Response> {
    return auth.request("/logout", { method: "POST", headers }, env);
  }

  it("セッションを消して 204", async () => {
    const login = await post({
      orgShortId: ORG.orgShortId,
      staffNumber: "S-0001",
      password: PASSWORD,
    });
    const cookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
    expect(sessionKv.store.size).toBe(1);

    const response = await logout({ Cookie: cookie });
    expect(response.status).toBe(204);
    expect(sessionKv.store.size).toBe(0);
  });

  it("Cookie が無くても 204（有効なセッションだったか分からせない）", async () => {
    const response = await logout();
    expect(response.status).toBe(204);
  });

  it("壊れた Cookie でも 204 で、何も消さない", async () => {
    await post({ orgShortId: ORG.orgShortId, staffNumber: "S-0001", password: PASSWORD });
    const response = await logout({ Cookie: "pk_session=broken.value" });
    expect(response.status).toBe(204);
    expect(sessionKv.store.size).toBe(1);
  });

  it("常に Cookie を失効させる", async () => {
    const response = await logout();
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
