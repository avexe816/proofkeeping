/**
 * `/api/v1/pricing-rules`（P5-03 / PK-SPEC-P5 §2.2・§3.2・§9）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   `billing.write` を持たないロールが **404** になること（403 ではない）
 *   §3.2 の梯子に載らない形が **400** で断られること（DECISIONS #123）
 *   `PATCH` が **`validTo` しか触らない**こと（値上げは行の追加）
 *   越境した ID が **404** になり、DB へ届かないこと
 *   登録・期間終了が `AuditLog` に残ること
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * **列の順序は schema/invoice.ts の `counterparty` / `pricingRule` の宣言順。**
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
const NOW = new Date("2026-08-12T09:00:00.000Z");

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
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PRICING_RULE_ID = `${ORG_SHORT_ID}__prc_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_PRICING_RULE_ID = `${OTHER_ORG_SHORT_ID}__prc_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

type TestRole = "ORG_ADMIN" | "PROPERTY_MANAGER" | "AUDITOR" | "INSPECTOR";

function deps(role: TestRole): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `counterparty` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function counterpartyRow(): unknown[] {
  return [
    COUNTERPARTY_ID,
    ORGANIZATION_ID,
    "CP-001",
    "サンプルホテル運営株式会社",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "keiri@example.co.jp",
    "[]",
    31,
    30,
    "FLOOR",
    1,
    0,
    0,
  ];
}

/** `pricing_rule` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function pricingRuleRow(overrides: { validTo?: string | null } = {}): unknown[] {
  return [
    PRICING_RULE_ID,
    ORGANIZATION_ID,
    COUNTERPARTY_ID,
    PROPERTY_ID,
    null, // room_type_id
    "CHECKOUT",
    "CLEAN_CHECKOUT",
    3_200,
    10,
    0, // is_reduced_rate
    "2026-01-01",
    overrides.validTo ?? null,
    50,
    0, // created_at
    0, // updated_at
  ];
}

function setup(role: TestRole = "ORG_ADMIN"): {
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

const VALID = {
  counterpartyId: COUNTERPARTY_ID,
  propertyId: PROPERTY_ID,
  taskType: "CHECKOUT" as const,
  itemCode: "CLEAN_CHECKOUT" as const,
  unitPrice: 3_200,
  taxRate: 10 as const,
  validFrom: "2026-01-01",
};

describe("GET /api/v1/pricing-rules", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await ctx.app.request(
      `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`,
      {},
      ctx.env,
    );

    expect(res.status).toBe(401);
  });

  it("counterpartyId が無ければ 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      "/api/v1/pricing-rules",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(400);
  });

  it("INSPECTOR は 404（security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(404);
  });

  it("§3.2 の段（stage）を添えて返す", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([pricingRuleRow()]);

    const res = await ctx.app.request(
      `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(200);
    const body: { data: { stage: number | null }[] } = await res.json();
    // 施設 + 作業種別 → 第 2 段。
    expect(body.data[0]?.stage).toBe(2);
  });

  it("応答に organizationId を含めない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);
    ctx.d1.enqueueRows([pricingRuleRow()]);

    const res = await ctx.app.request(
      `/api/v1/pricing-rules?counterpartyId=${COUNTERPARTY_ID}`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(JSON.stringify(await res.json())).not.toContain(ORGANIZATION_ID);
  });

  it("越境した counterpartyId は 404。**DB へ届かない**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      `/api/v1/pricing-rules?counterpartyId=${OTHER_ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.some((query) => query.sql.includes('from "counterparty"'))).toBe(false);
  });
});

describe("POST /api/v1/pricing-rules", () => {
  it("登録でき、監査ログが残る", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    const res = await send(ctx, "/api/v1/pricing-rules", "POST", VALID, cookie);

    expect(res.status).toBe(201);
    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(JSON.stringify(audit?.params)).toContain("pricingRule.created");
  });

  it.each([
    ["取引先の既定（全 null）", {}],
    ["作業種別のみ", { taskType: "CHECKOUT" as const }],
    ["施設のみ", { propertyId: PROPERTY_ID }],
    ["施設 + 作業種別", { propertyId: PROPERTY_ID, taskType: "CHECKOUT" as const }],
    [
      "施設 + 客室タイプ + 作業種別",
      { propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID, taskType: "CHECKOUT" as const },
    ],
  ])("%s は登録できる（梯子に載る 5 形）", async (_label, shape) => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    const res = await send(
      ctx,
      "/api/v1/pricing-rules",
      "POST",
      { ...VALID, propertyId: null, roomTypeId: null, taskType: null, ...shape },
      cookie,
    );

    expect(res.status).toBe(201);
  });

  it.each([
    ["施設 + 客室タイプ（作業種別なし）", { propertyId: PROPERTY_ID, roomTypeId: ROOM_TYPE_ID }],
    ["客室タイプのみ", { roomTypeId: ROOM_TYPE_ID }],
    [
      "客室タイプ + 作業種別（施設なし）",
      { roomTypeId: ROOM_TYPE_ID, taskType: "CHECKOUT" as const },
    ],
  ])("%s は 400（永遠に選ばれない設定を保存しない）", async (_label, shape) => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    // どの形も `roomTypeId` を持つ（それが梯子から外れる原因）。
    const res = await send(
      ctx,
      "/api/v1/pricing-rules",
      "POST",
      { ...VALID, propertyId: null, taskType: null, ...shape },
      cookie,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "UNRESOLVABLE_RULE_SHAPE" });
    expect(ctx.d1.queries.some((query) => query.sql.includes('insert into "pricing_rule"'))).toBe(
      false,
    );
  });

  it.each([
    ["単価が小数", { ...VALID, unitPrice: 3_200.5 }],
    ["単価が負", { ...VALID, unitPrice: -1 }],
    ["税率が 5%", { ...VALID, taxRate: 5 }],
    ["品目コードが語彙外", { ...VALID, itemCode: "CLEAN_UNKNOWN" }],
    ["validFrom の形が違う", { ...VALID, validFrom: "2026/01/01" }],
  ])("%s なら 400", async (_label, body) => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/pricing-rules", "POST", body, cookie);

    expect(res.status).toBe(400);
  });

  it("validTo が validFrom より前なら 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(
      ctx,
      "/api/v1/pricing-rules",
      "POST",
      { ...VALID, validTo: "2025-12-31" },
      cookie,
    );

    expect(res.status).toBe(400);
  });

  it("存在しない取引先なら 404", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]);

    const res = await send(ctx, "/api/v1/pricing-rules", "POST", VALID, cookie);

    expect(res.status).toBe(404);
  });

  it.each([["PROPERTY_MANAGER"], ["AUDITOR"]] as const)("%s は書き込めない（404）", async (role) => {
    const ctx = setup(role);
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/pricing-rules", "POST", VALID, cookie);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v1/pricing-rules/:pricingRuleId", () => {
  it("期間を閉じられ、監査ログが残る", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([pricingRuleRow()]);

    const res = await send(
      ctx,
      `/api/v1/pricing-rules/${PRICING_RULE_ID}`,
      "PATCH",
      { validTo: "2026-09-30" },
      cookie,
    );

    expect(res.status).toBe(200);
    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(JSON.stringify(audit?.params)).toContain("pricingRule.closed");
  });

  it("**単価を書き換えない**（値上げは行の追加）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([pricingRuleRow()]);

    await send(
      ctx,
      `/api/v1/pricing-rules/${PRICING_RULE_ID}`,
      "PATCH",
      { validTo: "2026-09-30", unitPrice: 9_999 },
      cookie,
    );

    const update = ctx.d1.queries.find((query) => query.sql.includes('update "pricing_rule"'));
    expect(update?.sql).toContain('"valid_to"');
    expect(update?.sql).not.toContain('"unit_price"');
    expect(update?.params).not.toContain(9_999);
  });

  it("validTo が validFrom より前なら 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([pricingRuleRow()]);

    const res = await send(
      ctx,
      `/api/v1/pricing-rules/${PRICING_RULE_ID}`,
      "PATCH",
      { validTo: "2025-01-01" },
      cookie,
    );

    expect(res.status).toBe(400);
  });

  it("越境した ID は 404。**DB へ届かない**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(
      ctx,
      `/api/v1/pricing-rules/${OTHER_PRICING_RULE_ID}`,
      "PATCH",
      { validTo: "2026-09-30" },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.some((query) => query.sql.includes('from "pricing_rule"'))).toBe(false);
  });

  it("存在しない ID は 404", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]);

    const res = await send(
      ctx,
      `/api/v1/pricing-rules/${PRICING_RULE_ID}`,
      "PATCH",
      { validTo: "2026-09-30" },
      cookie,
    );

    expect(res.status).toBe(404);
  });
});

describe("削除の口が無い", () => {
  it("DELETE は 404", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, `/api/v1/pricing-rules/${PRICING_RULE_ID}`, "DELETE", {}, cookie);

    expect(res.status).toBe(404);
  });
});
