/**
 * `/api/v1/room-types`（P1-24 / PK-SPEC-P0 §24.3・§24.5）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   `property.write` を持たないロールが **404** になること（403 ではない）
 *   コードの重複が **409**、形の誤りが **400** で分かれること
 *   越境した `roomTypeId` が **404** になり、DB へ届かないこと
 *   作成・更新が `AuditLog` に残ること（security.md §6）
 *   **物理削除の口が無いこと**（CLAUDE.md §4）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * schema/property.ts の `roomType` の宣言順。** 列を足す task はここも直すこと。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import roomTypes from "./roomTypes.js";

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
const OTHER_ORG_SHORT_ID = "z9y8x7";
const ORGANIZATION_ID = "org_test_alpha";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const ROOM_TYPE_ID = `${ORG_SHORT_ID}__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_ROOM_TYPE_ID = `${OTHER_ORG_SHORT_ID}__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

function deps(role: "ORG_ADMIN" | "CLEANER"): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `room_type` の 1 行。**列の順序は schema/property.ts の宣言順。** */
function roomTypeRow(overrides: { isActive?: number } = {}): unknown[] {
  return [
    ROOM_TYPE_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    "TWN",
    "ツイン",
    2, // bed_count
    2, // capacity
    0, // sort_order
    overrides.isActive ?? 1,
    0, // created_at
    0, // updated_at
  ];
}

function setup(role: "ORG_ADMIN" | "CLEANER" = "ORG_ADMIN"): {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  cookie: () => Promise<string>;
} {
  const d1 = createFakeD1();
  const env = {
    SESSION: createFakeKv().namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, deps(role));
  api.route("/room-types", roomTypes);
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

async function send(
  ctx: ReturnType<typeof setup>,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  cookie: string | null,
): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie === null ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe("GET /api/v1/room-types", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await ctx.app.request("/api/v1/room-types?propertyId=x", {}, ctx.env);

    expect(res.status).toBe(401);
  });

  it("propertyId が無ければ 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await ctx.app.request("/api/v1/room-types", { headers: { Cookie: cookie } }, ctx.env);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
  });

  it("無効化済みも返す（設定を編むための口のため）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([roomTypeRow({ isActive: 0 })]);

    const res = await ctx.app.request(
      `/api/v1/room-types?propertyId=${PROPERTY_ID}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(200);
    // 一覧のクエリに `is_active` の条件が載っていないこと。
    const select = ctx.d1.queries.find((query) => query.sql.includes('from "room_type"'));
    expect(select?.sql).not.toContain('"is_active" = ?');
  });

  it("応答に organizationId を含めない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([roomTypeRow()]);

    const res = await ctx.app.request(
      `/api/v1/room-types?propertyId=${PROPERTY_ID}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(JSON.stringify(await res.json())).not.toContain(ORGANIZATION_ID);
  });
});

describe("POST /api/v1/room-types", () => {
  const valid = { propertyId: PROPERTY_ID, code: "TWN", name: "ツイン", bedCount: 2 };

  it("作成でき、監査ログが残る（security.md §6）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/room-types", "POST", valid, cookie);

    expect(res.status).toBe(201);
    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.params)).toContain("property.created");
  });

  it("コードが重複していれば 409。**500 にしない**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueChanges(0); // onConflictDoNothing で見送られた

    const res = await send(ctx, "/api/v1/room-types", "POST", valid, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "DUPLICATE_CODE" });
    // 作られていないので監査ログも残さない。
    expect(ctx.d1.queries.filter((query) => query.sql.includes("audit_log"))).toEqual([]);
  });

  it("コードに記号が混ざっていれば 400（CSV の列が割れるため）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/room-types", "POST", { ...valid, code: "T,WN" }, cookie);

    expect(res.status).toBe(400);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("insert"))).toEqual([]);
  });

  it("名称が空なら 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/room-types", "POST", { ...valid, name: "  " }, cookie);

    expect(res.status).toBe(400);
  });

  it("bedCount が 0 でも受ける（未入力と区別する）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/room-types", "POST", { ...valid, bedCount: 0 }, cookie);

    expect(res.status).toBe(201);
  });

  it("清掃スタッフは作成できない（404。403 ではない / INV-31）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/room-types", "POST", valid, cookie);

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("insert"))).toEqual([]);
  });

  it("越境した propertyId は 404。**DB へ届かない**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    const crossTenant = `${OTHER_ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

    const res = await send(
      ctx,
      "/api/v1/room-types",
      "POST",
      { ...valid, propertyId: crossTenant },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("insert"))).toEqual([]);
  });
});

describe("PATCH /api/v1/room-types/:roomTypeId", () => {
  it("更新でき、監査ログが残る", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([roomTypeRow()]); // findRoomTypeById

    const res = await send(
      ctx,
      `/api/v1/room-types/${ROOM_TYPE_ID}`,
      "PATCH",
      { name: "ツインルーム" },
      cookie,
    );

    expect(res.status).toBe(200);
    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(JSON.stringify(audit?.params)).toContain("property.updated");
  });

  it("無効化は isActive = false で行う（DELETE の口が無い）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([roomTypeRow()]);

    const res = await send(
      ctx,
      `/api/v1/room-types/${ROOM_TYPE_ID}`,
      "PATCH",
      { isActive: false },
      cookie,
    );

    expect(res.status).toBe(200);
    expect(ctx.d1.queries.some((query) => query.sql.startsWith("update"))).toBe(true);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("delete"))).toEqual([]);
  });

  it("DELETE の口が無い（物理削除を作らない / CLAUDE.md §4）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, `/api/v1/room-types/${ROOM_TYPE_ID}`, "DELETE", {}, cookie);

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("delete"))).toEqual([]);
  });

  it("越境した roomTypeId は 404。**DB へ届かない**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(
      ctx,
      `/api/v1/room-types/${OTHER_ROOM_TYPE_ID}`,
      "PATCH",
      { name: "ツイン" },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("存在しなければ 404", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    // 行を積まない＝0 件。

    const res = await send(
      ctx,
      `/api/v1/room-types/${ROOM_TYPE_ID}`,
      "PATCH",
      { name: "ツイン" },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("update"))).toEqual([]);
  });

  it("code は更新できない（取込と外部連携が突き合わせる鍵）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([roomTypeRow()]);

    const res = await send(
      ctx,
      `/api/v1/room-types/${ROOM_TYPE_ID}`,
      "PATCH",
      { code: "DBL" },
      cookie,
    );

    // 未知のキーは無視され、`code` を含む UPDATE は発行されない。
    expect(res.status).toBe(200);
    const update = ctx.d1.queries.find((query) => query.sql.startsWith("update"));
    expect(update?.sql).not.toContain('"code"');
  });

  it("清掃スタッフは更新できない（404）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([roomTypeRow()]);

    const res = await send(
      ctx,
      `/api/v1/room-types/${ROOM_TYPE_ID}`,
      "PATCH",
      { name: "ツイン" },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("update"))).toEqual([]);
  });
});
