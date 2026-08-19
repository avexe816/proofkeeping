/**
 * ルール設定 API の配線（P4-13 / PK-SPEC-P4 §2.7・§6.4）。
 *
 * ルール: .claude/rules/security.md §1 / .claude/rules/testing.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **`OWNER` / `ORG_ADMIN` だけ**（施設責任者にも開かない / §6.4）
 *   - 語彙に無いルールコードは 400
 *   - **ルールの条件式を送る口が無い**（§13 の未決事項）
 *   - 消す口が無い
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import ruleConfigs from "./ruleConfigs.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
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

/** `property` の 1 行。**列の順序は schema/property.ts の宣言順。** */
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

function setup(role = "ORG_ADMIN"): Ctx {
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
  api.route("/rule-configs", ruleConfigs);
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

async function get(ctx: Ctx, path: string, cookie: string | null): Promise<Response> {
  return ctx.app.request(path, { headers: cookie === null ? {} : { Cookie: cookie } }, ctx.env);
}

async function patch(ctx: Ctx, ruleCode: string, body: unknown, cookie: string): Promise<Response> {
  return ctx.app.request(
    `/api/v1/rule-configs/${ruleCode}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe("GET /api/v1/rule-configs — 一覧（§2.7）", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    expect((await get(ctx, `/api/v1/rule-configs?propertyId=${PROPERTY_ID}`, null)).status).toBe(
      401,
    );
  });

  it("施設が無ければ 400", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/rule-configs", await ctx.cookie())).status).toBe(400);
  });

  it("`ORG_ADMIN` は 14 個すべてを読める（設定の無いものも既定として）", async () => {
    const ctx = setup("ORG_ADMIN");
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await get(ctx, `/api/v1/rule-configs?propertyId=${PROPERTY_ID}`, await ctx.cookie());
    expect(res.status).toBe(200);
    const body: { data: { ruleCode: string; isDefault: boolean }[] } = await res.json();
    expect(body.data).toHaveLength(14);
    expect(body.data.every((row) => row.isDefault)).toBe(true);
  });

  it("実装済みかどうかを示す（未実装の 4 つを隠さない）", async () => {
    const ctx = setup("ORG_ADMIN");
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await get(ctx, `/api/v1/rule-configs?propertyId=${PROPERTY_ID}`, await ctx.cookie());
    const body: { data: { ruleCode: string; isImplemented: boolean }[] } = await res.json();
    const unimplemented = body.data
      .filter((row) => !row.isImplemented)
      .map((row) => row.ruleCode);
    expect(unimplemented).toEqual(["R007", "R008", "R009", "R011"]);
  });

  it("**`PROPERTY_MANAGER` は 404**（§6.4 の表）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await get(ctx, `/api/v1/rule-configs?propertyId=${PROPERTY_ID}`, await ctx.cookie());
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`CLEANER` / `INSPECTOR` も 404", async () => {
    for (const role of ["CLEANER", "INSPECTOR"]) {
      const ctx = setup(role);
      const res = await get(
        ctx,
        `/api/v1/rule-configs?propertyId=${PROPERTY_ID}`,
        await ctx.cookie(),
      );
      expect(res.status, role).toBe(404);
    }
  });

  it("`AUDITOR` は読める（内部統制の確認）", async () => {
    const ctx = setup("AUDITOR");
    ctx.d1.enqueueRows([propertyRow()]);
    const res = await get(ctx, `/api/v1/rule-configs?propertyId=${PROPERTY_ID}`, await ctx.cookie());
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/v1/rule-configs/:ruleCode — 設定（§2.7）", () => {
  it("語彙に無いルールコードは 400", async () => {
    const ctx = setup();
    const res = await patch(ctx, "R099", { isEnabled: false }, await ctx.cookie());
    expect(res.status).toBe(400);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("**`AUDITOR` は書き込めない**（security.md §1）", async () => {
    const ctx = setup("AUDITOR");
    const res = await patch(
      ctx,
      "R001",
      { propertyId: PROPERTY_ID, isEnabled: false },
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
  });

  it("**`PROPERTY_MANAGER` は書き込めない**", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await patch(
      ctx,
      "R001",
      { propertyId: PROPERTY_ID, isEnabled: false },
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
  });

  it("`isEnabled` が無ければ 400", async () => {
    const ctx = setup();
    expect((await patch(ctx, "R001", { propertyId: PROPERTY_ID }, await ctx.cookie())).status).toBe(
      400,
    );
  });

  it("閾値の値が数値でなければ 400", async () => {
    const ctx = setup();
    const res = await patch(
      ctx,
      "R001",
      { propertyId: PROPERTY_ID, isEnabled: true, thresholds: { minSignals: "2" } },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("閾値の鍵が多すぎれば 400", async () => {
    const ctx = setup();
    const thresholds: Record<string, number> = {};
    for (let index = 0; index < 21; index += 1) thresholds[`k${String(index)}`] = index;
    const res = await patch(
      ctx,
      "R001",
      { propertyId: PROPERTY_ID, isEnabled: true, thresholds },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("壊れた JSON は 400（500 にしない）", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      "/api/v1/rule-configs/R001",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: await ctx.cookie() },
        body: "{",
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
  });
});

describe("触れないもの（§13 の未決事項）", () => {
  it("DELETE の口が無い", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      "/api/v1/rule-configs/R001",
      { method: "DELETE", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });

  it("POST の口が無い（新しいルールを足せない）", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      "/api/v1/rule-configs",
      { method: "POST", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });
});
