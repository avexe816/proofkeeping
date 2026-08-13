/**
 * テナント middleware（P0-10）。
 *
 * `TenantContext` の組み立てだけを見る。DB は注入した代役で置き換え、
 * 「どんな行が返ってきたら文脈がどうなるか」を決定的に確かめる
 * （packages/db/src/test-support/fake-d1.ts と同じ方針。あちらは
 * パッケージ外へ公開していないため、ここでは関数ごと差し替える）。
 */

import type { Env, Role, TenantContext } from "@pk/db";
import { NotFoundError } from "@pk/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../lib/auth/cookie.js";
import { createSession } from "../lib/auth/session.js";
import { createFakeKv } from "../lib/auth/test-support/fake-kv.js";

import type { AppEnv } from "./context.js";
import { sessionMiddleware } from "./session.js";
import { tenantMiddleware, type TenantDeps } from "./tenant.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-08-12T09:00:00.000Z");

// セッションの有効期限は `createSession()` が `NOW` から 12 時間で切る一方、
// middleware は**実時刻**で失効を判定する。時計を止めないと、実時刻が
// `NOW + 12h` を過ぎた日から全件 401 になる（時限式で赤くなる）。
// `Date` だけを差し替える。タイマーごと差し替えると await が進まなくなる。
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const ORG_ID = "org_test_alpha";
const ORG_SHORT_ID = "a1b2c3";
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

interface MembershipRow {
  id: string;
  role: Role;
  isActive: boolean;
}

function membershipOf(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return { id: MEMBERSHIP_ID, role: "PROPERTY_MANAGER", isActive: true, ...overrides };
}

interface Harness {
  request(): Promise<Response>;
  /** ハンドラまで届いた `TenantContext`。届かなければ `null`。 */
  seen(): TenantContext | null;
  /** `listAssignedPropertyIds` が呼ばれた回数。 */
  assignmentCalls(): number;
}

function setup(options: {
  membership?: MembershipRow | undefined;
  membershipError?: Error;
  assignedPropertyIds?: string[];
}): Harness {
  const env = { SESSION: createFakeKv().namespace, SESSION_SECRET: SECRET } as unknown as Env;
  let tenant: TenantContext | null = null;
  let assignmentCalls = 0;

  const deps: TenantDeps = {
    findMembershipByUserId: () => {
      if (options.membershipError) return Promise.reject(options.membershipError);
      return Promise.resolve(options.membership);
    },
    listAssignedPropertyIds: () => {
      assignmentCalls++;
      return Promise.resolve(options.assignedPropertyIds ?? []);
    },
  };

  const app = new Hono<AppEnv>();
  app.use("*", sessionMiddleware());
  app.use("*", tenantMiddleware(deps));
  app.get("/probe", (c) => {
    tenant = c.get("tenant") ?? null;
    return c.body(null, 204);
  });

  return {
    request: async () => {
      const created = await createSession(env, {
        userId: USER_ID,
        organizationId: ORG_ID,
        orgShortId: ORG_SHORT_ID,
        membershipId: MEMBERSHIP_ID,
        authMethod: "PASSWORD",
        now: NOW,
      });
      return app.request(
        "/probe",
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${created.cookieValue}` } },
        env,
      );
    },
    seen: () => tenant,
    assignmentCalls: () => assignmentCalls,
  };
}

describe("TenantContext の組み立て", () => {
  it("組織 ID とロールをセッションと membership から採る", async () => {
    const harness = setup({ membership: membershipOf({ role: "INSPECTOR" }) });

    expect((await harness.request()).status).toBe(204);
    const tenant = harness.seen();
    expect(tenant?.organizationId).toBe(ORG_ID);
    expect(tenant?.orgShortId).toBe(ORG_SHORT_ID);
    expect(tenant?.role).toBe("INSPECTOR");
  });

  it("施設スコープロールは property_assignment から担当施設を入れる", async () => {
    const harness = setup({
      membership: membershipOf({ role: "CLEANER" }),
      assignedPropertyIds: [`${ORG_SHORT_ID}__prop_A`, `${ORG_SHORT_ID}__prop_B`],
    });

    await harness.request();

    expect(harness.seen()?.allowedPropertyIds).toEqual([
      `${ORG_SHORT_ID}__prop_A`,
      `${ORG_SHORT_ID}__prop_B`,
    ]);
  });

  it("担当施設ゼロでも通す（空配列は「1 件も見えない」の意味）", async () => {
    const harness = setup({ membership: membershipOf({ role: "CLEANER" }), assignedPropertyIds: [] });

    expect((await harness.request()).status).toBe(204);
    expect(harness.seen()?.allowedPropertyIds).toEqual([]);
  });

  it("組織全体ロールでは property_assignment を引かない", async () => {
    // scopeToProperties() がこの値を参照しないため。D1 の往復を 1 回減らす。
    const harness = setup({ membership: membershipOf({ role: "ORG_ADMIN" }) });

    await harness.request();

    expect(harness.assignmentCalls()).toBe(0);
    expect(harness.seen()?.allowedPropertyIds).toEqual([]);
  });

  it("施設スコープロールでは必ず引く", async () => {
    const harness = setup({ membership: membershipOf({ role: "VENDOR_ADMIN" }) });

    await harness.request();

    expect(harness.assignmentCalls()).toBe(1);
  });

  it("now は session middleware が作った 1 つを共有する", async () => {
    const harness = setup({ membership: membershipOf() });

    await harness.request();

    expect(harness.seen()?.now).toBeInstanceOf(Date);
  });

  it("ロールをセッションから採らない（毎リクエスト membership を引く）", async () => {
    // DECISIONS #020。セッションは PASSWORD 発行だが、membership 側が
    // CLEANER ならそちらが正。降格が即時に効くことの確認。
    const harness = setup({ membership: membershipOf({ role: "CLEANER" }) });

    await harness.request();

    expect(harness.seen()?.role).toBe("CLEANER");
  });
});

describe("拒否", () => {
  async function expectUnauthenticated(harness: Harness): Promise<void> {
    const res = await harness.request();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
    expect(harness.seen()).toBeNull();
  }

  it("membership が無い", async () => {
    await expectUnauthenticated(setup({ membership: undefined }));
  });

  it("membership が無効化されている", async () => {
    await expectUnauthenticated(setup({ membership: membershipOf({ isActive: false }) }));
  });

  it("membership がセッションと食い違う", async () => {
    // 招待し直しなどで所属が作り直された場合。古いセッションを使い回させない。
    await expectUnauthenticated(
      setup({ membership: membershipOf({ id: `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGZ` }) }),
    );
  });

  it("セッションの ID が壊れていても 404 ではなく 401", async () => {
    // 文脈が作れないだけで、資源の有無は何も語っていない。
    await expectUnauthenticated(setup({ membershipError: new NotFoundError() }));
  });

  it("NotFoundError 以外の例外を 401 に丸めない", async () => {
    // シャード解決の失敗を「ログインし直せば直る」と読ませない。
    // 500 への写像とログの無害化は apiErrorHandler の責務
    // （この app には登録していないので Hono 既定のハンドラが 500 を返す）。
    const harness = setup({ membershipError: new Error("SHARD_BINDING_MISSING:SHARD_07") });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await harness.request()).status).toBe(500);

    spy.mockRestore();
  });
});
