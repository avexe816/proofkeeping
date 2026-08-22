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
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "OWNER", isEffectiveActive: true }),
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

async function getVendor(ctx: Ctx, query: string, cookie: string | null): Promise<Response> {
  return ctx.app.request(
    `/api/v1/dashboard/vendor${query}`,
    { headers: cookie === null ? {} : { Cookie: cookie } },
    ctx.env,
  );
}

/**
 * `VENDOR_PLAN` を契約済みにする（`isModuleEnabled()` が最初に引く 1 行）。
 *
 * **代役は行を積んだ順に返す。** ハンドラの最初のクエリが契約の判定なので、
 * ここで 1 行積めば「契約済み」になる。
 */
function grantVendorPlan(ctx: Ctx): void {
  ctx.d1.enqueueRows([[`${ORG_SHORT_ID}__ent_01JBXQ3ZK8N4P2VYR6ABCDEFGH`]]);
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

/**
 * 清掃会社プラン（P5-15 / PK-SPEC-P5 §7.2）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **請求を見られないロールは 404**（security.md §1「`INSPECTOR` は
 *     請求情報を見られない」）。402 を先に返すと、契約状況を通じて
 *     資源の存在が読める（`lib/entitlement.ts` の注記）
 *   - 契約していなければ 402
 *   - **全社ビューを持たないロールも 404**（§7.1 の 403 と違う。
 *     判定を `billing.read` × 組織全体 の 1 つにまとめてある）
 *   - **稼働の数字は rollup から**（§7.1 MUST を §7.2 にも掛ける）
 *   - **個人が並ぶ問い合わせを出していない**（security.md §5）
 */
describe("GET /api/v1/dashboard/vendor", () => {
  it("認証が無ければ 401", async () => {
    const ctx = setup();
    expect((await getVendor(ctx, "", null)).status).toBe(401);
  });

  it.each(["INSPECTOR", "CLEANER", "VENDOR_ADMIN"])(
    "%s は 404（請求情報を見られない / security.md §1）",
    async (role) => {
      const ctx = setup(role);
      grantVendorPlan(ctx);
      const response = await getVendor(ctx, "", await ctx.cookie());
      expect(response.status).toBe(404);
    },
  );

  it("`PROPERTY_MANAGER` も 404（担当施設だけでは組織平均を出せない）", async () => {
    // `/org` は 403 だが、こちらは `billing.read` を**組織全体**の対象で
    // 問うので、担当施設のみのロールはそこで落ちる（判定を 1 つにまとめた）。
    const ctx = setup("PROPERTY_MANAGER");
    grantVendorPlan(ctx);
    const response = await getVendor(ctx, "", await ctx.cookie());
    expect(response.status).toBe(404);
  });

  it("契約していなければ 402", async () => {
    const ctx = setup();
    // 行を積まない = `module_entitlement` に該当が無い。
    const response = await getVendor(ctx, "?month=2026-09", await ctx.cookie());
    expect(response.status).toBe(402);
  });

  it("権限を先に判定する（402 が資源の存在を示唆しない）", async () => {
    // 契約していない組織の `CLEANER`。**402 ではなく 404。**
    const ctx = setup("CLEANER");
    const response = await getVendor(ctx, "?month=2026-09", await ctx.cookie());
    expect(response.status).toBe(404);
  });

  it.each(["OWNER", "ORG_ADMIN", "AUDITOR"])("%s は読める", async (role) => {
    const ctx = setup(role);
    grantVendorPlan(ctx);
    const response = await getVendor(ctx, "?month=2026-09", await ctx.cookie());
    expect(response.status).toBe(200);
  });

  it("対象月の形が違えば 400", async () => {
    const ctx = setup();
    grantVendorPlan(ctx);
    expect((await getVendor(ctx, "?month=2026-9", await ctx.cookie())).status).toBe(400);
  });

  it("未指定なら業務日の月と、その月の閉区間を返す", async () => {
    const ctx = setup();
    grantVendorPlan(ctx);
    const response = await getVendor(ctx, "", await ctx.cookie());
    const body: { month: string; from: string; to: string } = await response.json();

    expect(body).toMatchObject({ month: "2026-09", from: "2026-09-01", to: "2026-09-30" });
  });

  it("売上も未回収も、確定した請求書が無ければ null（0 円と書かない）", async () => {
    const ctx = setup();
    grantVendorPlan(ctx);
    const response = await getVendor(ctx, "?month=2026-09", await ctx.cookie());
    const body: { summary: { salesTotal: number | null; unpaidTotal: number | null } } =
      await response.json();

    expect(body.summary.salesTotal).toBeNull();
    expect(body.summary.unpaidTotal).toBeNull();
  });

  it("**タスクテーブルを直接集計していない**（§7.1 MUST と同じ扱い）", async () => {
    const ctx = setup();
    grantVendorPlan(ctx);
    await getVendor(ctx, "?month=2026-09", await ctx.cookie());

    const aggregatesTasks = ctx.d1.queries.some(
      (query) => query.sql.includes("cleaning_task") && /count\(|sum\(/i.test(query.sql),
    );
    expect(aggregatesTasks).toBe(false);
    expect(ctx.d1.queries.some((query) => query.sql.includes("daily_property_rollup"))).toBe(true);
  });

  it("個人の一覧を引いていない（人数だけを数える / security.md §5）", async () => {
    const ctx = setup();
    grantVendorPlan(ctx);
    await getVendor(ctx, "?month=2026-09", await ctx.cookie());

    const membershipQueries = ctx.d1.queries.filter((query) => query.sql.includes("membership"));
    expect(membershipQueries.length).toBeGreaterThan(0);
    for (const query of membershipQueries) {
      expect(query.sql, query.sql).toMatch(/count\(/i);
    }
    // ユーザー表そのものを引いていない（氏名・スタッフ番号を持ってこない）。
    expect(ctx.d1.queries.some((query) => /\bfrom "user"/i.test(query.sql))).toBe(false);
  });

  it("テナント横断の JOIN を発行していない", async () => {
    const ctx = setup();
    grantVendorPlan(ctx);
    await getVendor(ctx, "?month=2026-09", await ctx.cookie());

    for (const query of ctx.d1.queries) {
      expect(query.sql, query.sql).not.toMatch(/\bjoin\b/i);
    }
  });
});
