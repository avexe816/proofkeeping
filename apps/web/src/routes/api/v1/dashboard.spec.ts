/**
 * 組織ダッシュボード API の配線（P5-14 / PK-SPEC-P5 §7.1）。
 *
 * ルール: .claude/rules/security.md §1 / .claude/rules/testing.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **全社ビューを持たないロールは 403**（§23.5 / security.md §1）。
 *     `PROPERTY_MANAGER` / `INSPECTOR` / `CLEANER` は組織全体の数字を
 *     見られない。**404 にしない** — 経路は資源ではない
 *   - 対象月の形が違えば 400。未指定なら業務日の月
 *   - **タスクテーブルを直接集計していない**（§7.1 MUST）。
 *     発行された SQL に `cleaning_task` の集計が現れないことで見る
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import dashboard from "./dashboard.js";

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

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "OWNER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

interface Ctx {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  cookie: () => Promise<string>;
}

function setup(role = "OWNER"): Ctx {
  const kv = createFakeKv();
  const d1 = createFakeD1();
  const env = {
    SESSION: kv.namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
    CONFIG: createFakeKv().namespace,
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, depsFor(role));
  api.route("/dashboard", dashboard);
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

async function get(ctx: Ctx, query: string, cookie: string | null): Promise<Response> {
  return ctx.app.request(
    `/api/v1/dashboard/org${query}`,
    { headers: cookie === null ? {} : { Cookie: cookie } },
    ctx.env,
  );
}

describe("GET /api/v1/dashboard/org", () => {
  it("認証が無ければ 401", async () => {
    const ctx = setup();
    expect((await get(ctx, "", null)).status).toBe(401);
  });

  it.each(["PROPERTY_MANAGER", "INSPECTOR", "CLEANER", "VENDOR_ADMIN"])(
    "%s は 403（全社ビューを持たない）",
    async (role) => {
      const ctx = setup(role);
      const response = await get(ctx, "", await ctx.cookie());
      expect(response.status).toBe(403);
    },
  );

  it.each(["OWNER", "ORG_ADMIN", "AUDITOR"])("%s は読める", async (role) => {
    const ctx = setup(role);
    const response = await get(ctx, "?month=2026-09", await ctx.cookie());
    expect(response.status).toBe(200);
  });

  it("対象月の形が違えば 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    expect((await get(ctx, "?month=2026-9", cookie)).status).toBe(400);
    expect((await get(ctx, "?month=2026-13", cookie)).status).toBe(400);
    expect((await get(ctx, "?month=202609", cookie)).status).toBe(400);
  });

  it("未指定なら業務日の月と、その月の閉区間を返す", async () => {
    const ctx = setup();
    const response = await get(ctx, "", await ctx.cookie());
    const body: { month: string; from: string; to: string } = await response.json();

    expect(body.month).toBe("2026-09");
    expect(body.from).toBe("2026-09-01");
    expect(body.to).toBe("2026-09-30");
  });

  it("集計が無ければ `hasRollup` が偽（0 と区別する）", async () => {
    const ctx = setup();
    const response = await get(ctx, "?month=2026-09", await ctx.cookie());
    const body: { hasRollup: boolean } = await response.json();

    expect(body.hasRollup).toBe(false);
  });

  it("費用は確定した請求書が無ければ null（0 円と書かない）", async () => {
    const ctx = setup();
    const response = await get(ctx, "?month=2026-09", await ctx.cookie());
    const body: { summary: { cleaningCost: number | null } } = await response.json();

    expect(body.summary.cleaningCost).toBeNull();
  });

  it("**タスクテーブルを直接集計していない**（§7.1 MUST）", async () => {
    const ctx = setup();
    await get(ctx, "?month=2026-09", await ctx.cookie());

    const aggregatesTasks = ctx.d1.queries.some(
      (query) => query.sql.includes("cleaning_task") && /count\(|sum\(/i.test(query.sql),
    );
    expect(aggregatesTasks).toBe(false);
    // 代わりに集計テーブルを読んでいる。
    expect(ctx.d1.queries.some((query) => query.sql.includes("daily_property_rollup"))).toBe(true);
  });

  it("テナント横断の JOIN を発行していない", async () => {
    const ctx = setup();
    await get(ctx, "?month=2026-09", await ctx.cookie());

    for (const query of ctx.d1.queries) {
      expect(query.sql, query.sql).not.toMatch(/\bjoin\b/i);
    }
  });
});
