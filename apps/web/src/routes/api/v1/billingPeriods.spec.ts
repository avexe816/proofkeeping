/**
 * `/api/v1/billing-periods`（P5-05 / PK-SPEC-P5 §2.8・§6.1・§9）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   `billing.read` / `billing.write` を持たないロールが **404**（403 ではない）
 *   知らない `status` が **400**（黙って全件を返さない）
 *   `OPEN` 以外からの集計が **409**（締め直して金額が動かない / §2.8）
 *   越境した `billingPeriodId` が **404** になり、DB へ届かないこと
 *   状態変更が `AuditLog` に残ること（CLAUDE.md §5）
 *   **合意・差戻しの口が無いこと**（P5-12 の範囲 / §6.2 MUST）
 *   **物理削除の口が無いこと**（CLAUDE.md §4）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * schema/invoice.ts の `billing_period` の宣言順。**
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import billingPeriods from "./billingPeriods.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-10-01T00:00:00.000Z");

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
const PERIOD_ID = `${ORG_SHORT_ID}__bper_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_PERIOD_ID = `${OTHER_ORG_SHORT_ID}__bper_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

type TestRole = "ORG_ADMIN" | "PROPERTY_MANAGER" | "INSPECTOR" | "AUDITOR";

function deps(role: TestRole): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `billing_period` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function periodRow(status = "OPEN"): unknown[] {
  return [
    PERIOD_ID,
    ORGANIZATION_ID,
    COUNTERPARTY_ID,
    "2026-09-01",
    "2026-09-30",
    status,
    null, // aggregated_at
    null, // agreed_at
    0, // agreed_by_counterparty
    null, // invoice_id
    0, // created_at
    0, // updated_at
  ];
}

/** `counterparty` の 1 行（`POST /` が締め日を読む）。 */
function counterpartyRow(closingDay = 31): unknown[] {
  return [
    COUNTERPARTY_ID,
    ORGANIZATION_ID,
    "CP-001",
    "サンプルホテル運営株式会社",
    null,
    "T1234567890123",
    "1000001",
    "東京都千代田区1-1-1",
    null,
    "経理部",
    "山田",
    "keiri@example.co.jp",
    "[]",
    closingDay,
    30,
    "FLOOR",
    1,
    0,
    0,
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
  api.route("/billing-periods", billingPeriods);
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

async function get(
  ctx: ReturnType<typeof setup>,
  path: string,
  cookie: string,
): Promise<Response> {
  return ctx.app.request(path, { headers: { cookie } }, ctx.env);
}

async function post(
  ctx: ReturnType<typeof setup>,
  path: string,
  cookie: string,
): Promise<Response> {
  return ctx.app.request(path, { method: "POST", headers: { cookie } }, ctx.env);
}

describe("GET /api/v1/billing-periods", () => {
  it("一覧を返す。**組織 ID を含めない**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);

    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(200);

    const body = await response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      billingPeriodId: PERIOD_ID,
      counterpartyId: COUNTERPARTY_ID,
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
      status: "REVIEWING",
      agreedByCounterparty: false,
      invoiceId: null,
    });
    expect(JSON.stringify(body)).not.toContain(ORGANIZATION_ID);
  });

  it("**金額を返さない**（§2.8 に列が無い / DECISIONS #124）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow()]);

    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    const body = await response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).not.toHaveProperty("totalAmount");
    expect(body.data[0]).not.toHaveProperty("subtotalAmount");
  });

  it("知らない status は 400（黙って全件を返さない）", async () => {
    const ctx = setup();
    const response = await get(ctx, "/api/v1/billing-periods?status=REVIEWINGG", await ctx.cookie());
    expect(response.status).toBe(400);
  });

  it("`INSPECTOR` は 404（請求情報を見られない / security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(404);
  });

  it("`AUDITOR` は読める（組織全体・読取専用）", async () => {
    const ctx = setup("AUDITOR");
    ctx.d1.enqueueRows([periodRow()]);
    const response = await get(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(200);
  });
});

describe("POST /api/v1/billing-periods/:id/aggregate", () => {
  it("`OPEN` を `REVIEWING` へ進め、監査ログに残す", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("OPEN")]); // findBillingPeriodById
    ctx.d1.enqueueRows([]); // updateBillingPeriodStatus
    ctx.d1.enqueueRows([]); // recordAudit

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ billingPeriodId: PERIOD_ID, status: "REVIEWING" });

    const statements = ctx.d1.queries.map((query) => query.sql);
    expect(statements.some((sql) => sql.includes("update") && sql.includes("billing_period"))).toBe(
      true,
    );
    expect(statements.some((sql) => sql.includes("audit_log"))).toBe(true);
  });

  it("`REVIEWING` からの集計は 409（締め直して金額が動かない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
    // **更新へ進んでいない。** `select` にも `updated_at` 列が現れるので、
    // 文の種類（先頭の動詞）で見る。
    expect(
      ctx.d1.queries.some((query) => query.sql.trimStart().toLowerCase().startsWith("update")),
    ).toBe(false);
  });

  it("`INVOICED` からの集計も 409", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("INVOICED")]);
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
  });

  it("越境した ID は 404 で、DB へ届かない", async () => {
    const ctx = setup();
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${OTHER_PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("`PROPERTY_MANAGER` は 404（`billing.write` を持たない）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });

  it("`AUDITOR` は書き込めない", async () => {
    const ctx = setup("AUDITOR");
    const response = await post(
      ctx,
      `/api/v1/billing-periods/${PERIOD_ID}/aggregate`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/v1/billing-periods", () => {
  it("締め日から期間を導いて起票する（月末締め・10/1 → 9 月分）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(31)]); // findCounterpartyById
    ctx.d1.enqueueRows([]); // ensureBillingPeriod の検索
    ctx.d1.enqueueRows([]); // insert

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
    });
  });

  it("20 日締めなら 8/21〜9/20", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(20)]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(await response.json()).toMatchObject({
      periodFrom: "2026-08-21",
      periodTo: "2026-09-20",
    });
  });

  it("既にあれば 200 で既存を返す（2 回押しても 2 行作らない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(31)]);
    ctx.d1.enqueueRows([[PERIOD_ID]]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ billingPeriodId: PERIOD_ID });
    expect(
      ctx.d1.queries.some((query) => query.sql.trimStart().toLowerCase().startsWith("insert")),
    ).toBe(false);
  });

  it("`counterpartyId` が無ければ 400", async () => {
    const ctx = setup();
    const response = await post(ctx, "/api/v1/billing-periods", await ctx.cookie());
    expect(response.status).toBe(400);
  });

  it("**期間をリクエストで受け取らない**（締め日と合わない請求を作らせない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow(31)]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);

    const response = await post(
      ctx,
      `/api/v1/billing-periods?counterpartyId=${COUNTERPARTY_ID}&periodFrom=2020-01-01&periodTo=2020-01-31`,
      await ctx.cookie(),
    );
    expect(await response.json()).toMatchObject({
      periodFrom: "2026-09-01",
      periodTo: "2026-09-30",
    });
  });
});

describe("作ってはいけない口", () => {
  it.each(["agree", "reject", "request-review"])(
    "%s の口が無い（P5-12 の範囲 / §6.2 MUST）",
    async (action) => {
      const ctx = setup();
      const response = await post(
        ctx,
        `/api/v1/billing-periods/${PERIOD_ID}/${action}`,
        await ctx.cookie(),
      );
      expect(response.status).toBe(404);
      expect(ctx.d1.queries).toHaveLength(0);
    },
  );

  it("DELETE が無い（CLAUDE.md §4）", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/billing-periods/${PERIOD_ID}`,
      { method: "DELETE", headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });
});
