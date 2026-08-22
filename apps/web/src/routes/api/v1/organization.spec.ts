/**
 * `GET/PATCH /api/v1/organization/settings`（P1-22 / PK-SPEC-P1 §19.4）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   閾値の範囲（2〜10）を外れた値を **400** で断ること
 *   `organization.write` を持たないロールが **404** になること（403 ではない）
 *   変更が `AuditLog` に残ること（security.md §6「組織設定の変更」）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * schema/organization.ts の宣言順。** 列を足す task はここも直すこと。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import organization from "./organization.js";

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
const ORGANIZATION_ID = "org_test_alpha";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

function deps(role: TenantDeps extends never ? never : "ORG_ADMIN" | "CLEANER"): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isEffectiveActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `organization` の 1 行。**列の順序は schema/organization.ts の宣言順。** */
function organizationRow(threshold = 4): unknown[] {
  return [
    ORGANIZATION_ID,
    ORGANIZATION_ID,
    ORG_SHORT_ID,
    "テスト組織",
    "Asia/Tokyo",
    "ja",
    threshold,
    1, // is_active
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
  api.route("/organization", organization);
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

async function patch(
  ctx: ReturnType<typeof setup>,
  body: unknown,
  cookie: string | null,
): Promise<Response> {
  return ctx.app.request(
    "/api/v1/organization/settings",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(cookie === null ? {} : { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe("GET /api/v1/organization/settings", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await ctx.app.request("/api/v1/organization/settings", {}, ctx.env);

    expect(res.status).toBe(401);
  });

  it("閾値を返す", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([organizationRow(6)]);

    const res = await ctx.app.request(
      "/api/v1/organization/settings",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { propertySelectionThreshold: 6 } });
  });

  it("清掃スタッフも読める（画面の挙動を決める値のため）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([organizationRow()]);

    const res = await ctx.app.request(
      "/api/v1/organization/settings",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/v1/organization/settings", () => {
  it("閾値を変更でき、監査ログが残る（security.md §6）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([organizationRow(4)]); // 変更前

    const res = await patch(ctx, { propertySelectionThreshold: 7 }, cookie);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { propertySelectionThreshold: 7 } });
    expect(ctx.d1.queries.some((query) => query.sql.startsWith("update"))).toBe(true);
    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit?.params)).toContain("organization.updated");
  });

  it("下限（2）を下回れば 400。**丸めない**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await patch(ctx, { propertySelectionThreshold: 1 }, cookie);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_REQUEST" });
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("update"))).toEqual([]);
  });

  it("上限（10）を超えれば 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await patch(ctx, { propertySelectionThreshold: 11 }, cookie);

    expect(res.status).toBe(400);
  });

  it("整数でなければ 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await patch(ctx, { propertySelectionThreshold: 4.5 }, cookie);

    expect(res.status).toBe(400);
  });

  it("項目が無ければ 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await patch(ctx, {}, cookie);

    expect(res.status).toBe(400);
  });

  it("清掃スタッフは変更できない（404。403 ではない / INV-31）", async () => {
    const ctx = setup("CLEANER");
    const cookie = await ctx.cookie();

    const res = await patch(ctx, { propertySelectionThreshold: 5 }, cookie);

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.filter((query) => query.sql.startsWith("update"))).toEqual([]);
  });
});
