/**
 * 料金設定 API の配線（P5-03 / PK-SPEC-P5 §2.2・§3.2）。
 *
 * ルール: .claude/rules/billing.md §8 / .claude/rules/security.md §1
 *         .claude/rules/testing.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **5 段階の優先順位で解決される**（P5-03 の完了条件 / `/resolve`）
 *   - **有効期間が判定される**（同上）
 *   - **単価を書き換える口が無い**（PUT / PATCH を持たない）
 *   - 該当が無ければ `resolved: null`（0 を返さない / §3.2 MUST）
 *   - 書けるのは `OWNER` / `ORG_ADMIN` だけ
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import pricingRules from "./pricingRules.js";

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
const ROOM_TYPE_ID = `${ORG_SHORT_ID}__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PRICING_RULE_ID = `${ORG_SHORT_ID}__prc_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_PRICING_RULE_ID = "z9y8x7__prc_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "OWNER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `counterparty` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function counterpartyRow(): unknown[] {
  return [
    COUNTERPARTY_ID,
    ORGANIZATION_ID,
    "CP001",
    "サンプル清掃株式会社",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "billing@example.com",
    "[]",
    31,
    30,
    "FLOOR",
    1,
    NOW.getTime(),
    NOW.getTime(),
  ];
}

/** `pricing_rule` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function pricingRuleRow(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const row: Record<string, unknown> = {
    id: PRICING_RULE_ID,
    organizationId: ORGANIZATION_ID,
    counterpartyId: COUNTERPARTY_ID,
    propertyId: null,
    roomTypeId: null,
    taskType: null,
    itemCode: "CLEAN_CHECKOUT",
    unitPrice: 3000,
    taxRate: 10,
    isReducedRate: 0,
    validFrom: "2026-01-01",
    validTo: null,
    priority: 50,
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...overrides,
  };
  return Object.values(row);
}

const VALID_BODY = {
  counterpartyId: COUNTERPARTY_ID,
  itemCode: "CLEAN_CHECKOUT",
  unitPrice: 3200,
  validFrom: "2026-10-01",
};

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
  api.route("/pricing-rules", pricingRules);
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

async function send(
  ctx: Ctx,
  method: string,
  path: string,
  body: unknown,
  cookie: string,
): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    ctx.env,
  );
}

/** `/resolve` の問い合わせ文字列。 */
function resolveQuery(extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    counterpartyId: COUNTERPARTY_ID,
    propertyId: PROPERTY_ID,
    taskType: "CHECKOUT",
    itemCode: "CLEAN_CHECKOUT",
    serviceDate: "2026-09-09",
    ...extra,
  });
  return `/api/v1/pricing-rules/resolve?${params.toString()}`;
}

describe("GET /api/v1/pricing-rules — 一覧（§2.2）", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    expect(
      (await get(ctx, `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`, null)).status,
    ).toBe(401);
  });

  it("取引先の指定が無ければ 400", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/pricing-rules", await ctx.cookie())).status).toBe(400);
  });

  it("**畳まずに全部返す**（どれが勝つかは billing の純粋関数）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([
      pricingRuleRow(),
      pricingRuleRow({ id: "b", propertyId: PROPERTY_ID, unitPrice: 3500 }),
    ]);

    const res = await get(
      ctx,
      `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(200);
    const body: { data: unknown[] } = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("取引先が無ければ 404", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    expect(
      (await get(ctx, `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`, await ctx.cookie()))
        .status,
    ).toBe(404);
  });

  it("`effectiveOn` の書式が違えば 400", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    const res = await get(
      ctx,
      `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}&effectiveOn=2026/09/09`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("**`CLEANER` は 404**（請求情報を見られない）", async () => {
    const ctx = setup("CLEANER");
    const res = await get(
      ctx,
      `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`AUDITOR` は読める", async () => {
    const ctx = setup("AUDITOR");
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([pricingRuleRow()]);
    expect(
      (await get(ctx, `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`, await ctx.cookie()))
        .status,
    ).toBe(200);
  });
});

describe("GET /api/v1/pricing-rules/resolve — 5 段階（§3.2 / P5-03 の完了条件）", () => {
  it("**より具体的な規則が勝つ**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([
      pricingRuleRow({ id: "default", unitPrice: 1000 }),
      pricingRuleRow({
        id: "full",
        propertyId: PROPERTY_ID,
        roomTypeId: ROOM_TYPE_ID,
        taskType: "CHECKOUT",
        unitPrice: 5000,
      }),
    ]);

    const res = await get(ctx, resolveQuery({ roomTypeId: ROOM_TYPE_ID }), await ctx.cookie());
    expect(res.status).toBe(200);
    const body: { resolved: { stage: string; unitPrice: number } | null } = await res.json();
    expect(body.resolved).toMatchObject({ stage: "PROPERTY_ROOM_TYPE_TASK", unitPrice: 5000 });
  });

  it("取引先の既定まで落ちる", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([pricingRuleRow({ unitPrice: 1000 })]);

    const res = await get(ctx, resolveQuery(), await ctx.cookie());
    const body: { resolved: { stage: string } | null } = await res.json();
    expect(body.resolved?.stage).toBe("COUNTERPARTY_DEFAULT");
  });

  it("**有効期間の外は当たらない**（P5-03 の完了条件）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([pricingRuleRow({ validFrom: "2026-10-01" })]);

    const res = await get(ctx, resolveQuery(), await ctx.cookie());
    const body: { resolved: unknown } = await res.json();
    expect(body.resolved).toBeNull();
  });

  it("終了日を過ぎていれば当たらない", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([pricingRuleRow({ validTo: "2026-08-31" })]);

    const body: { resolved: unknown } = await (
      await get(ctx, resolveQuery(), await ctx.cookie())
    ).json();
    expect(body.resolved).toBeNull();
  });

  it("**該当が無ければ `null`。0 円を返さない**（§3.2 MUST）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([]);

    const body: { resolved: unknown } = await (
      await get(ctx, resolveQuery(), await ctx.cookie())
    ).json();
    expect(body.resolved).toBeNull();
  });

  it("鍵が欠けていれば 400（「当たらなかった」と混ぜない）", async () => {
    const ctx = setup();
    const res = await get(
      ctx,
      `/api/v1/pricing-rules/resolve?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("役務提供日の書式が違えば 400", async () => {
    const ctx = setup();
    const res = await get(ctx, resolveQuery({ serviceDate: "2026/09/09" }), await ctx.cookie());
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/pricing-rules — 追加（§2.2）", () => {
  it("追加できる", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([pricingRuleRow({ unitPrice: 3200, validFrom: "2026-10-01" })]);

    const res = await send(ctx, "POST", "/api/v1/pricing-rules", VALID_BODY, await ctx.cookie());
    expect(res.status).toBe(201);
  });

  it("**単価が小数なら 400**（整数だけ / billing.md §4）", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/pricing-rules",
      { ...VALID_BODY, unitPrice: 3200.5 },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("単価が負なら 400", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/pricing-rules",
      { ...VALID_BODY, unitPrice: -1 },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("終了日が開始日より前なら 400", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/pricing-rules",
      { ...VALID_BODY, validTo: "2026-09-30" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("語彙に無い品目なら 400", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/pricing-rules",
      { ...VALID_BODY, itemCode: "CLEAN_UNKNOWN" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("取引先が無ければ 404", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    const res = await send(ctx, "POST", "/api/v1/pricing-rules", VALID_BODY, await ctx.cookie());
    expect(res.status).toBe(404);
  });

  it("**`PROPERTY_MANAGER` は書けない**（404）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await send(ctx, "POST", "/api/v1/pricing-rules", VALID_BODY, await ctx.cookie());
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`AUDITOR` は書けない", async () => {
    const ctx = setup("AUDITOR");
    expect(
      (await send(ctx, "POST", "/api/v1/pricing-rules", VALID_BODY, await ctx.cookie())).status,
    ).toBe(404);
  });
});

describe("POST /api/v1/pricing-rules/:id/close — 期間を閉じる（§2.2）", () => {
  it("終了日を入れられる", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([pricingRuleRow()]); // before
    ctx.d1.enqueueRows([pricingRuleRow()]); // closePricingRule 内の findPricingRuleById
    ctx.d1.enqueueRows([pricingRuleRow({ validTo: "2026-12-31" })]); // after

    const res = await send(
      ctx,
      "POST",
      `/api/v1/pricing-rules/${PRICING_RULE_ID}/close`,
      { validTo: "2026-12-31" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(200);
    const body: { data: { validTo: string | null } } = await res.json();
    expect(body.data.validTo).toBe("2026-12-31");
  });

  it("**開始日より前へは閉じられない**（400）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([pricingRuleRow({ validFrom: "2026-06-01" })]);
    ctx.d1.enqueueRows([pricingRuleRow({ validFrom: "2026-06-01" })]);

    const res = await send(
      ctx,
      "POST",
      `/api/v1/pricing-rules/${PRICING_RULE_ID}/close`,
      { validTo: "2026-01-01" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("**単価は送れない**（送っても効かない — 型に無い）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([pricingRuleRow()]);
    ctx.d1.enqueueRows([pricingRuleRow()]);
    ctx.d1.enqueueRows([pricingRuleRow({ validTo: "2026-12-31" })]);

    const res = await send(
      ctx,
      "POST",
      `/api/v1/pricing-rules/${PRICING_RULE_ID}/close`,
      { validTo: "2026-12-31", unitPrice: 1 },
      await ctx.cookie(),
    );
    const body: { data: { unitPrice: number } } = await res.json();
    expect(body.data.unitPrice).toBe(3000);
  });

  it("日付の書式が違えば 400", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([pricingRuleRow()]);
    const res = await send(
      ctx,
      "POST",
      `/api/v1/pricing-rules/${PRICING_RULE_ID}/close`,
      { validTo: "2026/12/31" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("別組織の ID は 404", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      `/api/v1/pricing-rules/${OTHER_PRICING_RULE_ID}/close`,
      { validTo: "2026-12-31" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });
});

describe("書き換える口が無い（§2.2）", () => {
  it("**PATCH は 404**（値上げは行の追加）", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/pricing-rules/${PRICING_RULE_ID}`,
      { unitPrice: 9999 },
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
  });

  it("**DELETE も 404**", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      `/api/v1/pricing-rules/${PRICING_RULE_ID}`,
      { method: "DELETE", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });
});
