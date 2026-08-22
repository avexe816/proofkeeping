/**
 * 停止済みユーザーの**発行済みセッション**が、次のリクエストで拒まれること
 * （DECISIONS #263）。
 *
 * ── なぜ 3 経路とも固定するのか ─────────────────────────
 * 判定の材料（`findMembershipByUserId()`）は 1 つでも、**それを見る場所は
 * 3 つある。**
 *
 *   `/m/*`      `requireMobileContext()` → `requireAppContext()` → 302
 *   `/app/*`    `requireAppContext()`                            → 302
 *   `/api/v1/*` `tenantMiddleware()`                             → 401
 *
 * 片方だけ直すと「画面は止まるが API は通る」状態が作れる。**3 つとも
 * 同じ値（`isEffectiveActive`）を見ていること**をここで固定する。
 *
 * ── 何を代役にしているか ────────────────────────────────
 * DB だけ。セッションは**本物を発行して KV に置く**（`createSession()`）。
 * 停止は「その後 DB がどんな行を返すか」で表す — `setUserActive()` が
 * 書き換えるのは `user.isActive` だけなので、`membership.isActive` は
 * `true` のまま返る。その組み合わせが通ってはいけない。
 */

import type { Env, Role } from "@pk/db";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const findMembershipByUserId = vi.fn();
const listAssignedPropertyIds = vi.fn();
const findUserById = vi.fn();
const findOrganization = vi.fn();

vi.mock("@pk/db", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@pk/db");
  return {
    ...actual,
    findMembershipByUserId: (...args: unknown[]) => findMembershipByUserId(...args) as unknown,
    listAssignedPropertyIds: (...args: unknown[]) => listAssignedPropertyIds(...args) as unknown,
    findUserById: (...args: unknown[]) => findUserById(...args) as unknown,
    findOrganization: (...args: unknown[]) => findOrganization(...args) as unknown,
  };
});

const { SESSION_COOKIE_NAME } = await import("../auth/cookie.js");
const { createSession } = await import("../auth/session.js");
const { createFakeKv } = await import("../auth/test-support/fake-kv.js");
const { requireAppContext } = await import("./requireSession.js");
const { requireMobileContext } = await import("../mobile/session.js");
const { sessionMiddleware } = await import("../../middleware/session.js");
const { tenantMiddleware } = await import("../../middleware/tenant.js");

type AppEnv = import("../../middleware/context.js").AppEnv;

const NOW = new Date("2026-08-22T09:00:00.000Z");
const SECRET = "sessionActive-spec-secret-not-used-anywhere-else";
const ORG_ID = "org_test_alpha";
const SHORT = "a1b2c3";
const USER_ID = `${SHORT}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const MEMBERSHIP_ID = `${SHORT}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${SHORT}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

// セッションの絶対期限（PIN は 16 時間）は発行時刻から切る一方、
// 読み出しは実時刻で判定する。時計を止めないと時限式で赤くなる
// （`middleware/tenant.spec.ts` と同じ理由）。
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

/**
 * `findMembershipByUserId()` が返す行。
 * **論理積の作り方はリポジトリ側（`MembershipWithUser`）と同じにする。**
 */
function membershipRow(options: {
  isActive?: boolean;
  userIsActive?: boolean;
  role?: Role;
}): Record<string, unknown> {
  const isActive = options.isActive ?? true;
  const userIsActive = options.userIsActive ?? true;
  return {
    id: MEMBERSHIP_ID,
    userId: USER_ID,
    organizationId: ORG_ID,
    role: options.role ?? "CLEANER",
    isActive,
    userIsActive,
    isEffectiveActive: isActive && userIsActive,
    counterpartyId: null,
  };
}

function envOf(): Env {
  return { SESSION: createFakeKv().namespace, SESSION_SECRET: SECRET } as unknown as Env;
}

/** 現場ログインで発行された状態のセッション（PIN・16 時間）。 */
async function issuePinSession(env: Env): Promise<string> {
  const created = await createSession(env, {
    userId: USER_ID,
    organizationId: ORG_ID,
    orgShortId: SHORT,
    membershipId: MEMBERSHIP_ID,
    authMethod: "PIN",
    now: NOW,
  });
  return created.cookieValue;
}

function requestFor(path: string, cookieValue: string): Request {
  return new Request(`https://example.test${path}`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` },
  });
}

/** `/api/v1/*` の経路。`tenantMiddleware()` まで通す。 */
function apiApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", sessionMiddleware());
  app.use("*", tenantMiddleware());
  app.get("/api/v1/probe", (c) => c.body(null, 204));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  listAssignedPropertyIds.mockResolvedValue([PROPERTY_ID]);
  findUserById.mockResolvedValue({ id: USER_ID, displayName: "テスト 花子", locale: "ja" });
  findOrganization.mockResolvedValue({ locale: "ja", propertySelectionThreshold: 4 });
});

/** 3 経路をまとめて叩き、それぞれの結果を返す。 */
async function probeAllRoutes(): Promise<{ app: number; mobile: number; api: number }> {
  const env = envOf();
  const cookieValue = await issuePinSession(env);

  const statusOf = async (call: () => Promise<unknown>): Promise<number> => {
    try {
      await call();
      return 200;
    } catch (error) {
      if (error instanceof Response) return error.status;
      throw error;
    }
  };

  const app = await statusOf(() =>
    requireAppContext(env, requestFor("/app/dashboard", cookieValue), NOW),
  );
  const mobile = await statusOf(() =>
    requireMobileContext(env, requestFor("/m/today", cookieValue), NOW),
  );
  const api = (
    await apiApp().request(requestFor("/api/v1/probe", cookieValue), undefined, env)
  ).status;

  return { app, mobile, api };
}

describe("停止済みユーザーの発行済みセッション（3 経路）", () => {
  it("両方立っていれば通る（membership=true / user=true）", async () => {
    findMembershipByUserId.mockResolvedValue(membershipRow({}));
    expect(await probeAllRoutes()).toEqual({ app: 200, mobile: 200, api: 204 });
  });

  it("**アカウント停止で拒む**（membership=true / user=false）", async () => {
    // W-07 / W-12 の「利用を停止する」が作る状態。`setUserActive()` は
    // `user` 行だけを書き換えるので、`membership.isActive` は true のまま。
    findMembershipByUserId.mockResolvedValue(membershipRow({ userIsActive: false }));
    expect(await probeAllRoutes()).toEqual({ app: 302, mobile: 302, api: 401 });
  });

  it("所属の無効化でも拒む（membership=false / user=true）", async () => {
    findMembershipByUserId.mockResolvedValue(membershipRow({ isActive: false }));
    expect(await probeAllRoutes()).toEqual({ app: 302, mobile: 302, api: 401 });
  });

  it("両方落ちていれば当然拒む", async () => {
    findMembershipByUserId.mockResolvedValue(
      membershipRow({ isActive: false, userIsActive: false }),
    );
    expect(await probeAllRoutes()).toEqual({ app: 302, mobile: 302, api: 401 });
  });

  it("現場は `/m/login` へ、管理画面は `/login` へ戻す（行き先を取り違えない）", async () => {
    findMembershipByUserId.mockResolvedValue(membershipRow({ userIsActive: false }));
    const env = envOf();
    const cookieValue = await issuePinSession(env);

    const locationOf = async (call: () => Promise<unknown>): Promise<string> => {
      try {
        await call();
        return "";
      } catch (error) {
        if (error instanceof Response) return error.headers.get("Location") ?? "";
        throw error;
      }
    };

    expect(
      await locationOf(() =>
        requireMobileContext(env, requestFor("/m/today", cookieValue), NOW),
      ),
    ).toContain("/m/login");
    expect(
      await locationOf(() =>
        requireAppContext(env, requestFor("/app/dashboard", cookieValue), NOW),
      ),
    ).toContain("/login");
  });
});

describe("停止 → 再開", () => {
  it("停止した直後の次のリクエストで拒まれ、再開すると同じセッションで通る", async () => {
    const env = envOf();
    const cookieValue = await issuePinSession(env);
    const request = (): Request => requestFor("/m/today", cookieValue);

    // ① 停止前。通る。
    findMembershipByUserId.mockResolvedValue(membershipRow({}));
    await expect(requireMobileContext(env, request(), NOW)).resolves.toMatchObject({
      tenant: { role: "CLEANER" },
    });

    // ② 管理者が「利用を停止する」を押した。**セッションは消していない。**
    findMembershipByUserId.mockResolvedValue(membershipRow({ userIsActive: false }));
    await expect(requireMobileContext(env, request(), NOW)).rejects.toMatchObject({ status: 302 });

    // ③ 「利用を再開する」を押した。**同じ Cookie がまた通る**
    //    （KV のセッションを消していないので、入り直さなくてよい）。
    findMembershipByUserId.mockResolvedValue(membershipRow({}));
    await expect(requireMobileContext(env, request(), NOW)).resolves.toMatchObject({
      tenant: { role: "CLEANER" },
    });
  });
});

describe("クエリを増やしていない", () => {
  it("認証境界は `findUserById()` を呼ばない（JOIN 1 回で済ませる）", async () => {
    findMembershipByUserId.mockResolvedValue(membershipRow({}));
    const env = envOf();
    const cookieValue = await issuePinSession(env);

    await requireAppContext(env, requestFor("/app/dashboard", cookieValue), NOW);
    await apiApp().request(requestFor("/api/v1/probe", cookieValue), undefined, env);

    expect(findMembershipByUserId).toHaveBeenCalledTimes(2);
    // `/m/*` は表示名と言語のために `findUserById()` を引くが、**判定には
    // 使っていない。** ここで見ているのは `/app/*` と `/api/v1/*`。
    expect(findUserById).not.toHaveBeenCalled();
  });
});
