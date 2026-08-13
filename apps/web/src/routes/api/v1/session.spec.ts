/**
 * `POST /api/v1/auth/switch-property`（P0-14 / P0-21）。
 *
 * 仕様: docs/PK-SPEC-P0.md §23.4
 *
 * ── 見ているもの ────────────────────────────────────────
 * 到達できない施設が **404**（403 ではない）であること、全社ビューを
 * 持たないロールの `"ALL"` が **403** であること、そして切り替えが
 * セッションに残ること。**この 2 つの使い分けが P0-21 の要点。**
 *
 * 施設の解決そのもの（権限外が残っていたら既定へ戻す）は純粋関数の
 * `lib/property/selection.spec.ts`、KV への保存は
 * `lib/auth/session.spec.ts` が見ている。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession, readSession } from "../../../lib/auth/session.js";
import { createFakeKv, type FakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import session from "./session.js";

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
const ORG_SHORT_ID = "a1b2c3";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_ORG_PROPERTY_ID = "zz9zz9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

const DEPS: TenantDeps = {
  findMembershipByUserId: () =>
    Promise.resolve({ id: MEMBERSHIP_ID, role: "PROPERTY_MANAGER", isActive: true }),
  listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
};

/**
 * `property` の 1 行。**列の順序は schema/property.ts の宣言順。**
 * 位置で組むのは代役の `raw()` がそのまま drizzle に渡るため。
 */
function propertyRow(id: string, isActive = 1): unknown[] {
  return [
    id,
    "org_test_alpha",
    "HTLA",
    "property",
    null,
    null,
    "Asia/Tokyo",
    "05:00",
    // inspection_required（P1-01 が足した列。既定 false / PK-SPEC-P1 §5.2）
    0,
    1,
    isActive,
    0,
    0,
  ];
}

function setup(): {
  app: Hono<AppEnv>;
  env: Env;
  kv: FakeKv;
  d1: FakeD1;
  cookie: () => Promise<string>;
} {
  const kv = createFakeKv();
  const d1 = createFakeD1();
  const env = {
    SESSION: kv.namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, DEPS);
  api.route("/auth", session);
  app.route("/api/v1", api);

  return {
    app,
    env,
    kv,
    d1,
    cookie: async () => {
      const created = await createSession(env, {
        userId: USER_ID,
        organizationId: "org_test_alpha",
        orgShortId: ORG_SHORT_ID,
        membershipId: MEMBERSHIP_ID,
        authMethod: "PASSWORD",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

async function post(
  ctx: ReturnType<typeof setup>,
  body: unknown,
  cookie: string | null,
): Promise<Response> {
  return ctx.app.request(
    "/api/v1/auth/switch-property",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === null ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe("POST /api/v1/auth/switch-property", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await post(ctx, { propertyId: PROPERTY_ID }, null);

    expect(res.status).toBe(401);
  });

  it("担当施設なら 200 で、セッションに残る", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([propertyRow(PROPERTY_ID)]);

    const res = await post(ctx, { propertyId: PROPERTY_ID }, cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ propertyId: PROPERTY_ID });

    const stored = await readSession(ctx.env, cookie.split("=")[1] ?? "", NOW);
    expect(stored?.selectedPropertyId).toBe(PROPERTY_ID);
  });

  it("別組織の施設 ID は 404 で、DB を引かない", async () => {
    // 第 2 層（assertIdBelongsToTenant）。**403 を返さない**（存在を示唆する）。
    const ctx = setup();

    const res = await post(ctx, { propertyId: OTHER_ORG_PROPERTY_ID }, await ctx.cookie());

    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("同一組織でも担当外・存在しない施設は 404", async () => {
    // 第 1 層が 0 件にする。別組織のときと**同じ応答**でなければならない。
    const ctx = setup();

    const res = await post(ctx, { propertyId: PROPERTY_ID }, await ctx.cookie());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "RESOURCE_NOT_FOUND" });
  });

  it("無効化された施設は 404", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([propertyRow(PROPERTY_ID, 0)]);

    const res = await post(ctx, { propertyId: PROPERTY_ID }, await ctx.cookie());

    expect(res.status).toBe(404);
  });

  it('全社ビューを持たないロールの "ALL" は 403（§23.4 / §25.1）', async () => {
    // このテストの membership は PROPERTY_MANAGER。§23.1 の表で全社ビューなし。
    //
    // **403 を返してよい唯一の経路。** INV-31 が 404 を求めるのは
    // 「権限外の propertyId」で、`"ALL"` は資源ではなくスコープの指定。
    // どの組織にも同じように存在するので、403 でも漏れる情報が無い。
    const ctx = setup();

    const res = await post(ctx, { propertyId: "ALL" }, await ctx.cookie());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "SCOPE_FORBIDDEN" });
  });

  it("propertyId が無ければ 400", async () => {
    const ctx = setup();

    const res = await post(ctx, {}, await ctx.cookie());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
  });

  it("本体が JSON でなくても 400（例外を外へ出さない）", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      "/api/v1/auth/switch-property",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: await ctx.cookie() },
        body: "not json",
      },
      ctx.env,
    );

    expect(res.status).toBe(400);
  });

  it("失敗しても選択は変わらない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    const cookieValue = cookie.split("=")[1] ?? "";
    ctx.d1.enqueueRows([propertyRow(PROPERTY_ID)]);
    await post(ctx, { propertyId: PROPERTY_ID }, cookie);

    // 2 回目は行が返らない（担当外）。
    const res = await post(ctx, { propertyId: `${ORG_SHORT_ID}__prop_other` }, cookie);

    expect(res.status).toBe(404);
    const stored = await readSession(ctx.env, cookieValue, NOW);
    expect(stored?.selectedPropertyId).toBe(PROPERTY_ID);
  });
});
