/**
 * 認証 API のハンドラ（P0-08 /login・/logout / P0-09 /pin-login）。
 * ステータスコードと Cookie の写像。
 *
 * 認証の判定そのものは `lib/auth/login.spec.ts` と `lib/auth/pinLogin.spec.ts`
 * が見る。ここで確かめるのは「どの失敗も 401 で理由が 1 種類か」
 * 「レート制限が 429 になるか」「Cookie の属性が落ちていないか」。
 */

import { loginResponseSchema, pinLoginResponseSchema } from "@pk/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const { hashPin } = await import("../../../lib/auth/pin.js");
const { RATE_LIMITS } = await import("../../../lib/auth/rateLimit.js");
const { createFakeKv } = await import("../../../lib/auth/test-support/fake-kv.js");
const auth = (await import("./auth.js")).default;

type Env = import("@pk/db").Env;
type FakeKv = import("../../../lib/auth/test-support/fake-kv.js").FakeKv;

/**
 * テストの「いま」。**分の途中に固定する。**
 *
 * ── なぜ時計を止めるのか ────────────────────────────────
 * レート制限の窓は `windowIndex = floor(now / 60000)`（`lib/auth/rateLimit.ts`）。
 * 下のレート制限テストは 11〜21 回続けて POST し、1 回あたり PBKDF2 が
 * 走るので 0.5〜1 秒かかる。**実時刻のままだと、そのループが分の境界を
 * またいだ回だけ窓が切り替わってカウンタが 0 に戻り、最後の 1 回が
 * 429 ではなく 401 になる。**
 *
 * 実際にこれで CI が落ちた（フルランでは `/pin-login` が、単体では
 * 別のテストが落ち、走らせ直すと通る）。**再現率が数 % のフレークは
 * 「たまたま赤い」として扱われ、本物の失敗を隠す。**
 *
 * 秒を 30 に置いてあるのは、固定し忘れた経路が混じったときに
 * 前後 30 秒の余裕で気づけるようにするため。
 */
const FIXED_NOW = new Date("2026-09-10T05:00:30.000Z");

const ORG = { organizationId: "org_test_alpha", orgShortId: "a1b2c3" } as const;
const PASSWORD = "Correct1Horse";
const PIN = "8261";
const IP = "203.0.113.10";

let sessionKv: FakeKv;
let rateLimitKv: FakeKv;
let env: Env;
let passwordHash = "";
let pinHash = "";

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
  // **`Date` だけを固定する。** タイマーまで差し替えると、WebCrypto を
  // 待つ `await` が進まなくなる。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  // PBKDF2 は遅い。ファイル全体で 1 回ずつしか作らない。
  if (passwordHash === "") passwordHash = await hashPassword(PASSWORD);
  if (pinHash === "") pinHash = await hashPin(PIN);

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
    pinHash,
    pinMustChange: false,
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

afterEach(() => {
  vi.useRealTimers();
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

describe("POST /pin-login", () => {
  async function postPin(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return auth.request(
      "/pin-login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );
  }

  function credentials(overrides: Record<string, unknown> = {}) {
    return { orgShortId: ORG.orgShortId, staffNumber: "S-0001", pin: PIN, ...overrides };
  }

  beforeEach(() => {
    // 既定の所属は ORG_ADMIN（/login 用）。PIN が通るのは現場系だけ。
    findMembershipByUserId.mockResolvedValue({
      id: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000",
      organizationId: ORG.organizationId,
      role: "CLEANER",
      isActive: true,
    });
  });

  it("成功すると 200 と expiresAt / pinMustChange を返す", async () => {
    const response = await postPin(credentials());
    expect(response.status).toBe(200);
    const body = pinLoginResponseSchema.parse(await response.json());
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(body.pinMustChange).toBe(false);
  });

  it("Cookie の Max-Age は 16 時間（1 勤務）", async () => {
    // 管理系の 43200 秒（12 時間）と混ざらないこと。
    const response = await postPin(credentials());
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("pk_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=57600");
  });

  it("本体にセッション ID を入れない（httpOnly の意味を消さない）", async () => {
    const response = await postPin(credentials());
    const body: unknown = await response.json();
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([
      "expiresAt",
      "pinMustChange",
    ]);
  });

  it("PIN が違えば 401 と AUTH_FAILED のみ", async () => {
    const response = await postPin(credentials({ pin: "8262" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_FAILED" });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("組織が存在しなくても同じ 401 AUTH_FAILED", async () => {
    lookupOrganizationId.mockResolvedValue(null);
    const response = await postPin(credentials({ orgShortId: "zzzzzz" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_FAILED" });
  });

  it("管理系ロールは 401（4 桁で 16 時間のセッションを持たせない）", async () => {
    findMembershipByUserId.mockResolvedValue({
      id: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000",
      organizationId: ORG.organizationId,
      role: "ORG_ADMIN",
      isActive: true,
    });
    const response = await postPin(credentials());
    expect(response.status).toBe(401);
  });

  it.each([
    ["項目が足りない", { orgShortId: "a1b2c3", pin: PIN }],
    ["orgShortId の桁数が違う", { orgShortId: "a1b2", staffNumber: "S-0001", pin: PIN }],
    ["PIN が 3 桁", { orgShortId: "a1b2c3", staffNumber: "S-0001", pin: "826" }],
    ["PIN が英字", { orgShortId: "a1b2c3", staffNumber: "S-0001", pin: "abcd" }],
    ["パスワードを送ってきた", { orgShortId: "a1b2c3", staffNumber: "S-0001", password: PASSWORD }],
    ["本体が JSON でない", "not json"],
  ])("入力の形が違えば 400（%s）", async (_label, body) => {
    const response = await postPin(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
  });

  it("ポリシー違反の PIN（1234）でも 400 ではなく 401", async () => {
    // 400 と 401 が分かれると、その PIN がポリシー違反の値だと分かる。
    const response = await postPin(credentials({ pin: "1234" }));
    expect(response.status).toBe(401);
  });

  it("21 回目のリクエストは 429 と Retry-After（login の 10 回とは別の上限）", async () => {
    const body = credentials({ pin: "8262" });
    for (let i = 0; i < RATE_LIMITS.pinLogin.limit; i++) {
      const response = await postPin(body);
      expect(response.status, `${String(i + 1)} 回目`).toBe(401);
    }
    const limited = await postPin(body);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "RATE_LIMITED" });
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("/login と窓を共有しない（片方の総当たりで他方を止めない）", async () => {
    // 現場のログインが、管理系への総当たりの巻き添えで止まってはいけない。
    for (let i = 0; i < RATE_LIMITS.login.limit + 1; i++) {
      await post({ orgShortId: ORG.orgShortId, staffNumber: "S-0001", password: "Wrong1Password" });
    }
    const response = await postPin(credentials());
    expect(response.status).toBe(200);
  });

  it("レート制限に掛かったら認証まで進まない", async () => {
    const body = credentials();
    for (let i = 0; i < RATE_LIMITS.pinLogin.limit; i++) await postPin(body);
    vi.clearAllMocks();
    await postPin(body);
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
