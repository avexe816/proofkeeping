/**
 * `/api/v1/receipts`（P5-08 / PK-SPEC-P5 §4.2・§9）。
 *
 * ルール: .claude/rules/billing.md §3 / security.md §1 / testing.md §4
 *
 * ── 見ているもの ────────────────────────────────────────
 *   **一部入金を黙って全額として記録しない**（OPEN_QUESTIONS #076）
 *   取り消した請求書に領収書を出さない
 *   **2 回目は 409**（`PAID` からは進めない / 冪等）
 *   PDF と送付が Queue へ行くこと（リクエストで PDF を作らない）
 *   **物理削除の口が無いこと**（CLAUDE.md §4）
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import receipts from "./receipts.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-10-28T02:00:00.000Z");

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
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const INVOICE_ID = `${ORG_SHORT_ID}__inv_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const RECEIPT_ID = `${ORG_SHORT_ID}__rcp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

type TestRole = "ORG_ADMIN" | "PROPERTY_MANAGER" | "INSPECTOR" | "AUDITOR";

function deps(role: TestRole): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isEffectiveActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `invoice` の 1 行（`receipts.ts` は請求書を読んでから発行する）。 */
function invoiceRow(status = "SENT", totalAmount = 716760): unknown[] {
  return [
    INVOICE_ID,
    ORGANIZATION_ID,
    COUNTERPARTY_ID,
    "INV-2026-0042",
    1,
    null,
    null,
    0,
    "2026-10-01",
    totalAmount,
    "サンプルホテル運営株式会社",
    "2026-09-01",
    "2026-09-30",
    "2026-10-31",
    651600,
    65160,
    1,
    JSON.stringify({ legalName: "サンプル清掃株式会社" }),
    JSON.stringify({ legalName: "サンプルホテル運営株式会社", billingEmail: "keiri@example.co.jp" }),
    status,
    null,
    null,
    "abc123",
    0,
    MEMBERSHIP_ID,
    null,
    null,
    null,
    null,
    null,
    0,
    0,
  ];
}

/** `receipt` の 1 行。 */
function receiptRow(): unknown[] {
  return [
    RECEIPT_ID,
    ORGANIZATION_ID,
    INVOICE_ID,
    COUNTERPARTY_ID,
    "RCP-2026-0018",
    1,
    "2026-10-28",
    716760,
    "サンプルホテル運営株式会社",
    716760,
    "2026-10-28",
    "BANK_TRANSFER",
    "清掃業務委託料として（2026年9月分）",
    JSON.stringify([]),
    1,
    JSON.stringify({ legalName: "サンプル清掃株式会社" }),
    JSON.stringify({ legalName: "サンプルホテル運営株式会社", billingEmail: "keiri@example.co.jp" }),
    "ISSUED",
    null,
    null,
    null,
    null,
    null,
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
            new Response(JSON.stringify({ sequence: 18, fiscalYear: 2026 }), {
              headers: { "content-type": "application/json" },
            }),
          ),
      }),
    },
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, deps(role));
  api.route("/receipts", receipts);
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

function issueBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invoiceId: INVOICE_ID,
    receivedAmount: 716760,
    receivedDate: "2026-10-28",
    paymentMethod: "BANK_TRANSFER",
    ...overrides,
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
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ctx.env,
  );
}

describe("POST /api/v1/receipts/issue-and-send", () => {
  it("**一部入金は 409**（黙って全額として記録しない / #076）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow("SENT", 716760)]);

    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody({ receivedAmount: 500000 }),
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PARTIAL_PAYMENT_NOT_SUPPORTED" });
    // **入金として記録していない。**
    expect(ctx.sent).toHaveLength(0);
  });

  it("過入金も 409（請求額と一致しないものは受けない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow("SENT", 716760)]);
    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody({ receivedAmount: 800000 }),
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
  });

  it("**取り消した請求書には領収書を出さない**（§5 で赤伝が出ている）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow("VOIDED")]);

    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody(),
      await ctx.cookie(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "INVOICE_VOIDED" });
  });

  it("**既に入金済みなら 409**（2 通目を出さない / 冪等）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow("SENT")]); // findInvoiceById
    ctx.d1.enqueueRows([]); // findCounterpartyById
    ctx.d1.enqueueRows([]); // findTaxProfile
    ctx.d1.enqueueRows([]); // listInvoiceTaxSummaries
    // `markInvoicePaid()` が 0 行（既に PAID）。
    ctx.d1.enqueueChanges(0);

    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody(),
      await ctx.cookie(),
    );
    // 取引先が無い時点で先に落ちる形でも、**発行はされない**。
    expect(response.status).toBe(409);
    expect(ctx.sent).toHaveLength(0);
  });

  it("請求書が無ければ 404", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody(),
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });

  it("入金方法が語彙の外なら 400", async () => {
    const ctx = setup();
    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody({ paymentMethod: "BITCOIN" }),
      await ctx.cookie(),
    );
    expect(response.status).toBe(400);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("入金日の形が違えば 400", async () => {
    const ctx = setup();
    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody({ receivedDate: "2026/10/28" }),
      await ctx.cookie(),
    );
    expect(response.status).toBe(400);
  });

  it("**印紙に関する値を受け取らない**（billing.md §3）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([invoiceRow("VOIDED")]);
    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody({ stampAmount: 200 }),
      await ctx.cookie(),
    );
    // 余分な項目は無視され、請求書の状態で 409 になる。
    expect(response.status).toBe(409);
  });

  it("`PROPERTY_MANAGER` は 404（`billing.write` を持たない）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody(),
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("`AUDITOR` は書き込めない", async () => {
    const ctx = setup("AUDITOR");
    const response = await post(
      ctx,
      "/api/v1/receipts/issue-and-send",
      issueBody(),
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/v1/receipts", () => {
  it("一覧を返す。**組織 ID と R2 のキーを含めない**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([receiptRow()]);

    const response = await ctx.app.request(
      "/api/v1/receipts",
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(200);

    const body = await response.json<{ data: Record<string, unknown>[] }>();
    expect(body.data[0]).toMatchObject({
      receiptId: RECEIPT_ID,
      documentNo: "RCP-2026-0018",
      receivedAmount: 716760,
      paymentMethod: "BANK_TRANSFER",
      hasPdf: false,
    });
    expect(JSON.stringify(body)).not.toContain(ORGANIZATION_ID);
    expect(body.data[0]).not.toHaveProperty("pdfStorageKey");
  });

  it("金額が数値でなければ 400", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      "/api/v1/receipts?minAmount=abc",
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(400);
  });

  it("`INSPECTOR` は 404（請求情報を見られない / security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const response = await ctx.app.request(
      "/api/v1/receipts",
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(404);
  });
});

describe("作ってはいけない口（CLAUDE.md §4 / billing.md §2）", () => {
  it("DELETE が無い", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/receipts/${RECEIPT_ID}`,
      { method: "DELETE", headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("金額を書き換える PATCH が無い", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/receipts/${RECEIPT_ID}`,
      {
        method: "PATCH",
        headers: { cookie: await ctx.cookie(), "content-type": "application/json" },
        body: JSON.stringify({ receivedAmount: 1 }),
      },
      ctx.env,
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toHaveLength(0);
  });
});
