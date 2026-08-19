/**
 * 業務上の入室記録 API の配線（P4-10 / PK-SPEC-P4 §2.3・§4.1）。
 *
 * ルール: .claude/rules/security.md §1 / .claude/rules/testing.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **登録は施設責任者以上**（DECISIONS #115）。登録すると差異が抑制される
 *     ので、照合される側（現場・受託先）に書かせない
 *   - 業務日はサーバーが決める（日締め 05:00 / architecture.md §7）
 *   - 事前・事後の両方を受ける（§2.3）が、幅には上限がある
 *   - 更新・削除の口が無い
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import roomAccessLogs from "./roomAccessLogs.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
/** 2026-09-10 05:10 JST。業務日（日締め 05:00）は 2026-09-10。 */
const NOW = new Date("2026-09-09T20:10:00.000Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const ORG_SHORT_ID = "a1b2c3";
const ORGANIZATION_ID = "org_test_alpha";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_ID = `${ORG_SHORT_ID}__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "OWNER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `room` の 1 行。**列の順序は schema/property.ts の `room` 宣言順。** */
function roomRow(): unknown[] {
  return [
    ROOM_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    null, // building_id
    null, // floor_id
    null, // room_type_id
    "302", // room_number
    1, // is_sellable
    "DIRTY", // housekeeping_status
    "AVAILABLE", // sale_status
    "MANUAL", // source_type
    null, // external_room_id
    null, // note
    0, // sort_order
    1, // is_active
    NOW.getTime(),
    NOW.getTime(),
  ];
}

/** `property` の 1 行。**列の順序は schema/property.ts の `property` 宣言順。** */
function propertyRow(): unknown[] {
  return [
    PROPERTY_ID,
    ORGANIZATION_ID,
    "HTLA",
    "テスト施設",
    null,
    null,
    null, // phone
    null, // contact_name
    "Asia/Tokyo",
    "05:00",
    0,
    null, // lost_item_retention_days（OPEN_QUESTIONS #052）
    0,
    1,
    NOW.getTime(),
    NOW.getTime(),
  ];
}

interface Ctx {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  cookie: () => Promise<string>;
}

function setup(role = "PROPERTY_MANAGER"): Ctx {
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
  useTenantMiddleware(api, depsFor(role));
  api.route("/room-access-logs", roomAccessLogs);
  app.route("/api/v1", api);

  return {
    app,
    env,
    d1,
    cookie: async () => {
      const created = await createSession(env, {
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        orgShortId: ORG_SHORT_ID,
        membershipId: MEMBERSHIP_ID,
        authMethod: "PASSWORD",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

/** 既定の登録内容。**入室は「いま」**（業務日 2026-09-10）。 */
function body(overrides: Record<string, unknown> = {}): unknown {
  return {
    roomId: ROOM_ID,
    purpose: "INSPECTION",
    enteredAt: NOW.getTime(),
    ...overrides,
  };
}

async function post(ctx: Ctx, payload: unknown, cookie: string | null): Promise<Response> {
  return ctx.app.request(
    "/api/v1/room-access-logs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === null ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(payload),
    },
    ctx.env,
  );
}

describe("POST /api/v1/room-access-logs — 登録（§2.3）", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    expect((await post(ctx, body(), null)).status).toBe(401);
  });

  it("施設責任者は登録できる。**業務日はサーバーが決める**", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    ctx.d1.enqueueRows([roomRow()]);
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(ctx, body(), await ctx.cookie());

    expect(res.status).toBe(201);
    // 05:10 JST は日締め 05:00 を過ぎているので当日扱い。
    expect(await res.json()).toMatchObject({
      data: { roomId: ROOM_ID, roomNumber: "302", businessDate: "2026-09-10" },
    });
  });

  it("日締め前の入室は前日の業務日になる", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    ctx.d1.enqueueRows([roomRow()]);
    ctx.d1.enqueueRows([propertyRow()]);

    // 2026-09-10 03:00 JST。日締め 05:00 の前なので業務日は 09-09。
    const res = await post(
      ctx,
      body({ enteredAt: new Date("2026-09-09T18:00:00.000Z").getTime() }),
      await ctx.cookie(),
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { businessDate: "2026-09-09" } });
  });

  it("`CLEANER` は登録できない（抑制を自分で作らせない）", async () => {
    const ctx = setup("CLEANER");
    ctx.d1.enqueueRows([roomRow()]);
    expect((await post(ctx, body(), await ctx.cookie())).status).toBe(404);
  });

  it("`INSPECTOR` も登録できない", async () => {
    const ctx = setup("INSPECTOR");
    ctx.d1.enqueueRows([roomRow()]);
    expect((await post(ctx, body(), await ctx.cookie())).status).toBe(404);
  });

  it("`VENDOR_ADMIN` も登録できない（受託側に消させない）", async () => {
    const ctx = setup("VENDOR_ADMIN");
    ctx.d1.enqueueRows([roomRow()]);
    expect((await post(ctx, body(), await ctx.cookie())).status).toBe(404);
  });

  it("`AUDITOR` は書き込めない（security.md §1）", async () => {
    const ctx = setup("AUDITOR");
    ctx.d1.enqueueRows([roomRow()]);
    expect((await post(ctx, body(), await ctx.cookie())).status).toBe(404);
  });

  it("存在しない客室は 404", async () => {
    const ctx = setup();
    expect((await post(ctx, body(), await ctx.cookie())).status).toBe(404);
  });

  it("事前登録（未来の入室）を受け付ける", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([roomRow()]);
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(
      ctx,
      body({ enteredAt: NOW.getTime() + 3 * 24 * 60 * 60 * 1000 }),
      await ctx.cookie(),
    );
    expect(res.status).toBe(201);
  });

  it("30 日より先の入室は 400（押し忘れが効き続けない）", async () => {
    const ctx = setup();
    const res = await post(
      ctx,
      body({ enteredAt: NOW.getTime() + 31 * 24 * 60 * 60 * 1000 }),
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("90 日より前の入室も 400", async () => {
    const ctx = setup();
    const res = await post(
      ctx,
      body({ enteredAt: NOW.getTime() - 91 * 24 * 60 * 60 * 1000 }),
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("退出が入室より前なら 400", async () => {
    const ctx = setup();
    const res = await post(
      ctx,
      body({ exitedAt: NOW.getTime() - 1000 }),
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("語彙に無い目的は 400", async () => {
    const ctx = setup();
    expect((await post(ctx, body({ purpose: "UNKNOWN" }), await ctx.cookie())).status).toBe(400);
  });

  it("業務日を送っても無視される（サーバーが決める）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([roomRow()]);
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(ctx, body({ businessDate: "2020-01-01" }), await ctx.cookie());

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { businessDate: "2026-09-10" } });
  });
});

describe("GET /api/v1/room-access-logs — 一覧（§2.3）", () => {
  async function get(ctx: Ctx, path: string, cookie: string | null): Promise<Response> {
    return ctx.app.request(path, { headers: cookie === null ? {} : { Cookie: cookie } }, ctx.env);
  }

  it("施設が無ければ 400", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/room-access-logs", await ctx.cookie())).status).toBe(400);
  });

  it("施設責任者は読める", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await get(
      ctx,
      `/api/v1/room-access-logs?propertyId=${PROPERTY_ID}`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("`CLEANER` は 404", async () => {
    const ctx = setup("CLEANER");
    const res = await get(
      ctx,
      `/api/v1/room-access-logs?propertyId=${PROPERTY_ID}`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("業務日の形が違えば 400", async () => {
    const ctx = setup();
    const res = await get(
      ctx,
      `/api/v1/room-access-logs?propertyId=${PROPERTY_ID}&from=2026/09/09`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });
});

describe("更新・削除の口が無い（§4.1 の根拠を書き換えさせない）", () => {
  it("PATCH は 404", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      "/api/v1/room-access-logs/anything",
      { method: "PATCH", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });

  it("DELETE は 404", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      "/api/v1/room-access-logs/anything",
      { method: "DELETE", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });
});
