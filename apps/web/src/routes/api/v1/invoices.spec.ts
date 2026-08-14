/**
 * `/api/v1/invoices`（P5-07 / PK-SPEC-P5 §4.1・§9）。
 *
 * ルール: .claude/rules/billing.md §2・§7 / security.md §1 / testing.md §4
 *
 * ── 見ているもの ────────────────────────────────────────
 *   **`AGREED` でない締めからは発行できない**（A 案 / §6.1）
 *   **2 回目は既存の請求書を 200 で返す**（§4.3 MUST。2 通目を作らない）
 *   ①〜⑥ が 1 トランザクション（`batch()` で送られること）
 *   ロック（①）が採番（②）より先であること
 *   **物理削除・金額更新の口が無いこと**（CLAUDE.md §4 / billing.md §2）
 *   `INSPECTOR` / `PROPERTY_MANAGER` が 404 になること（403 ではない）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * schema/invoice.ts の宣言順。**
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import invoices from "./invoices.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-10-01T02:00:00.000Z");

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
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const INVOICE_ID = `${ORG_SHORT_ID}__inv_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_INVOICE_ID = `${OTHER_ORG_SHORT_ID}__inv_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

type TestRole = "ORG_ADMIN" | "PROPERTY_MANAGER" | "INSPECTOR" | "AUDITOR";

function deps(role: TestRole): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `billing_period` の 1 行。 */
function periodRow(status = "AGREED", invoiceId: string | null = null): unknown[] {
  return [
    PERIOD_ID,
    ORGANIZATION_ID,
    COUNTERPARTY_ID,
    "2026-09-01",
    "2026-09-30",
    status,
    null,
    null,
    1,
    invoiceId,
    0,
    0,
  ];
}

/** `invoice` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function invoiceRow(status = "CONFIRMED"): unknown[] {
  return [
    INVOICE_ID,
    ORGANIZATION_ID,
    COUNTERPARTY_ID,
    "INV-2026-0042",
    1, // revision
    null, // supersedes_id
    null, // credit_note_for_id
    0, // is_credit_note
    "2026-10-01",
    716760,
    "サンプルホテル運営株式会社",
    "2026-09-01",
    "2026-09-30",
    "2026-10-31",
    651600,
    65160,
    1, // is_qualified_invoice
    JSON.stringify({ legalName: "サンプル清掃株式会社" }),
    JSON.stringify({ legalName: "サンプルホテル運営株式会社", billingEmail: "keiri@example.co.jp" }),
    status,
    null, // pdf_storage_key
    null, // pdf_sha256
    "abc123", // payload_sha256
    0, // confirmed_at
    MEMBERSHIP_ID,
    null, // sent_at
    null, // paid_at
    null, // voided_at
    null, // void_reason
    null, // note
    0,
    0,
  ];
}

function setup(role: TestRole = "ORG_ADMIN"): {
  app: Hono<AppEnv>;
  env: Env;
  d1: FakeD1;
  sent: unknown[];
  cookie: () => Promise<string>;
} {
  const d1 = createFakeD1();
  const sent: unknown[] = [];
  const queue = { send: (message: unknown) => { sent.push(message); return Promise.resolve(); } };

  const env = {
    SESSION: createFakeKv().namespace,
    SESSION_SECRET: SECRET,
    SHARD_COUNT: "1",
    SHARD_00: d1.database,
    SHARD_MAP: createFakeKv().namespace,
    QUEUE_PDF_GENERATION: queue,
    QUEUE_NOTIFICATION: queue,
    DOCUMENT_SEQUENCER: {
      idFromName: () => "sequencer-id",
      get: () => ({
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ sequence: 42, fiscalYear: 2026 }), {
              headers: { "content-type": "application/json" },
            }),
          ),
      }),
    },
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, deps(role));
  api.route("/invoices", invoices);
  app.route("/api/v1", api);

  return {
    app,
    env,
    d1,
    sent,
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

async function post(
  ctx: ReturnType<typeof setup>,
  path: string,
  body: unknown,
  cookie: string,
): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "Idempotency-Key": "key-1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ctx.env,
  );
}

function sqls(ctx: ReturnType<typeof setup>): string[] {
  return ctx.d1.queries.map((query) => query.sql);
}

describe("POST /api/v1/invoices/issue-and-send", () => {
  it("**`AGREED` でない締めからは発行できない**（A 案 / §6.1）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);

    const response = await post(
      ctx,
      "/api/v1/invoices/issue-and-send",
      { billingPeriodId: PERIOD_ID },
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PERIOD_NOT_AGREED" });
    // **採番へ進んでいない。** 番号を無駄に消費しない。
    expect(ctx.sent).toHaveLength(0);
  });

  it("`OPEN` からも発行できない", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("OPEN")]);
    const response = await post(
      ctx,
      "/api/v1/invoices/issue-and-send",
      { billingPeriodId: PERIOD_ID },
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
  });

  it("**2 回目は既存の請求書を 200 で返す**（§4.3 MUST）", async () => {
    const ctx = setup();
    // 既に `invoiceId` が入っている締め。
    ctx.d1.enqueueRows([periodRow("INVOICED", INVOICE_ID)]);

    const response = await post(
      ctx,
      "/api/v1/invoices/issue-and-send",
      { billingPeriodId: PERIOD_ID },
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invoiceId: INVOICE_ID, alreadyIssued: true });
    // **新しい請求書を作っていない。**
    expect(sqls(ctx).some((sql) => sql.includes("insert") && sql.includes("invoice"))).toBe(false);
  });

  it("締めが無ければ 404", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    const response = await post(
      ctx,
      "/api/v1/invoices/issue-and-send",
      { billingPeriodId: PERIOD_ID },
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });

  it("`billingPeriodId` が無ければ 400", async () => {
    const ctx = setup();
    const response = await post(ctx, "/api/v1/invoices/issue-and-send", {}, await ctx.cookie());
    expect(response.status).toBe(400);
  });

  it("**金額をリクエストで受け取らない**（請求根拠が証跡から切れないように）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([periodRow("REVIEWING")]);
    const response = await post(
      ctx,
      "/api/v1/invoices/issue-and-send",
      { billingPeriodId: PERIOD_ID, totalAmount: 1 },
      await ctx.cookie(),
    );
    // 余分な項目は無視され、締めの状態で 409 になる（金額は効かない）。
    expect(response.status).toBe(409);
  });

  it("`PROPERTY_MANAGER` は 404（`billing.write` を持たない）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const response = await post(
      ctx,
      "/api/v1/invoices/issue-and-send",
      { billingPeriodId: PERIOD_ID },
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("`AUDITOR` は書き込めない", async () => {
    const ctx = setup("AUDITOR");
    const response = await post(
      ctx,
      "/api/v1/invoices/issue-and-send",
      { billingPeriodId: PERIOD_ID },
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/invoices", () => {
  it("一覧を返す。**組織 ID と R2 のキーを含めない**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow()]);

    const response = await ctx.app.request(
      "/api/v1/invoices",
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(200);

    const body = await response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).toMatchObject({
      invoiceId: INVOICE_ID,
      documentNo: "INV-2026-0042",
      totalAmount: 716760,
      hasPdf: false,
    });
    expect(JSON.stringify(body)).not.toContain(ORGANIZATION_ID);
    expect(body.data[0]).not.toHaveProperty("pdfStorageKey");
  });

  it("**3 条件で絞れる**（電子帳簿保存法 / §1.2 MUST）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow()]);

    await ctx.app.request(
      `/api/v1/invoices?from=2026-09-01&to=2026-10-31&minAmount=1000&maxAmount=999999&counterpartyId=${COUNTERPARTY_ID}`,
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );

    const params = ctx.d1.queries[0]?.params ?? [];
    expect(params).toContain("2026-09-01");
    expect(params).toContain("2026-10-31");
    expect(params).toContain(1000);
    expect(params).toContain(999999);
    expect(params).toContain(COUNTERPARTY_ID);
  });

  it("金額が数値でなければ 400", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      "/api/v1/invoices?minAmount=abc",
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(400);
  });

  it("`INSPECTOR` は 404（請求情報を見られない / security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const response = await ctx.app.request(
      "/api/v1/invoices",
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/invoices/:id", () => {
  it("越境した ID は 404 で、DB へ届かない", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/invoices/${OTHER_INVOICE_ID}`,
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });
});

describe("POST /api/v1/invoices/:id/resend", () => {
  it("**取り消した請求書は再送できない**（§5 で赤伝が出ている）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow("VOIDED")]);

    const response = await post(
      ctx,
      `/api/v1/invoices/${INVOICE_ID}/resend`,
      undefined,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.sent).toHaveLength(0);
  });

  it("発行済みなら送付をキューへ投げる", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow("SENT")]); // findSendableInvoice
    ctx.d1.enqueueRows([invoiceRow("SENT")]); // enqueueInvoiceDelivery の中
    ctx.d1.enqueueRows([]); // recordAudit

    const response = await post(
      ctx,
      `/api/v1/invoices/${INVOICE_ID}/resend`,
      undefined,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatchObject({
      kind: "INVOICE_DELIVERY",
      invoiceId: INVOICE_ID,
      toEmail: "keiri@example.co.jp",
    });
    expect(sqls(ctx).some((sql) => sql.includes("audit_log"))).toBe(true);
  });
});

describe("作ってはいけない口（CLAUDE.md §4 / billing.md §2）", () => {
  it("DELETE が無い", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/invoices/${INVOICE_ID}`,
      { method: "DELETE", headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("金額を書き換える PATCH が無い", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/invoices/${INVOICE_ID}`,
      {
        method: "PATCH",
        headers: { cookie: await ctx.cookie(), "content-type": "application/json" },
        body: JSON.stringify({ totalAmount: 1 }),
      },
      ctx.env,
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it.each(["void", "credit-note"])("%s の口が無い（P5-09 の範囲）", async (action) => {
    const ctx = setup();
    const response = await post(
      ctx,
      `/api/v1/invoices/${INVOICE_ID}/${action}`,
      {},
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });
});
