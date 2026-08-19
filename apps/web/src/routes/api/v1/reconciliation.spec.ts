/**
 * 稼働照合 API の配線（P4-05 / PK-SPEC-P4 §5.4・§6.4）。
 *
 * ルール: .claude/rules/security.md §1 / .claude/rules/testing.md §4
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **`CLEANER` / `INSPECTOR` が 404**（§6.4 / security.md §1）
 *   - **施設責任者にも手動再実行を与えない**（§6.4 の表）
 *   - 遡れるのは 90 日まで（§5.4）。未来の業務日も断る
 *   - 照合そのものはここで走らせず、Queue へ投げる（architecture.md §5）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * その `select()` の宣言順。** 列を足す task はここも直すこと。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import reconciliation from "./reconciliation.js";

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

/**
 * `property` の 1 行。**列の順序は schema/property.ts の `property` 宣言順**
 * （`findPropertyById()` は `select()` を絞らない）。
 */
function propertyRow(): unknown[] {
  return [
    PROPERTY_ID,
    ORGANIZATION_ID,
    "HTLA", // code
    "テスト施設", // name
    null, // postal_code
    null, // address
    null, // phone
    null, // contact_name
    "Asia/Tokyo",
    "05:00", // day_cutoff_time
    0, // inspection_required
    0, // sort_order
    1, // is_active
    NOW.getTime(),
    NOW.getTime(),
  ];
}

interface Ctx {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  /** キューへ投げられたメッセージ。**投入されたことをここで見る。** */
  queued: unknown[];
  cookie: () => Promise<string>;
}

function setup(role = "ORG_ADMIN"): Ctx {
  const kv = createFakeKv();
  const d1 = createFakeD1();
  const queued: unknown[] = [];
  const env = {
    SESSION: kv.namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
    QUEUE_RECONCILIATION: {
      send: (message: unknown) => {
        queued.push(message);
        return Promise.resolve();
      },
    },
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, depsFor(role));
  api.route("/reconciliation", reconciliation);
  app.route("/api/v1", api);

  return {
    app,
    env,
    d1,
    queued,
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

async function post(ctx: Ctx, body: unknown, cookie: string | null): Promise<Response> {
  return ctx.app.request(
    "/api/v1/reconciliation/runs",
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

describe("POST /api/v1/reconciliation/runs — 手動実行（§5.4）", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    expect((await post(ctx, {}, null)).status).toBe(401);
  });

  it("Queue へ投げて 202 を返す（ここで照合しない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-09-09" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ businessDate: "2026-09-09", queued: true });
    expect(ctx.queued).toHaveLength(1);
    expect(ctx.queued[0]).toMatchObject({
      kind: "RECONCILIATION",
      mode: "MANUAL",
      requestedById: MEMBERSHIP_ID,
      businessDate: "2026-09-09",
    });
  });

  it("当日の業務日も受け付ける", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-09-10" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(202);
  });

  it("未来の業務日は 400（終わっていない日を照合しない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-09-11" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(400);
    expect(ctx.queued).toEqual([]);
  });

  it("90 日より前は 400（§5.4）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-06-11" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(400);
    expect(ctx.queued).toEqual([]);
  });

  it("ちょうど 90 日前は受け付ける", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-06-12" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(202);
  });

  it("形が違う要求は 400", async () => {
    const ctx = setup();
    const res = await post(ctx, { propertyId: PROPERTY_ID }, await ctx.cookie());
    expect(res.status).toBe(400);
    expect(ctx.queued).toEqual([]);
  });

  it("存在しない施設は 404", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-09-09" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(404);
  });
});

describe("権限（§6.4 / security.md §1）", () => {
  it.each(["CLEANER", "INSPECTOR"])("%s は 404（403 は存在を示唆する）", async (role) => {
    const ctx = setup(role);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-09-09" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(404);
    expect(ctx.queued).toEqual([]);
  });

  it.each(["PROPERTY_MANAGER", "VENDOR_ADMIN", "AUDITOR"])(
    "%s も手動再実行はできない（§6.4 は OWNER / ORG_ADMIN のみ）",
    async (role) => {
      const ctx = setup(role);

      const res = await post(
        ctx,
        { propertyId: PROPERTY_ID, businessDate: "2026-09-09" },
        await ctx.cookie(),
      );

      expect(res.status).toBe(404);
      expect(ctx.queued).toEqual([]);
    },
  );

  it("OWNER は実行できる", async () => {
    const ctx = setup("OWNER");
    ctx.d1.enqueueRows([propertyRow()]);

    const res = await post(
      ctx,
      { propertyId: PROPERTY_ID, businessDate: "2026-09-09" },
      await ctx.cookie(),
    );

    expect(res.status).toBe(202);
  });
});
