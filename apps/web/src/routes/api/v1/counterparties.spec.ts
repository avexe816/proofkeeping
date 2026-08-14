/**
 * `/api/v1/counterparties`（P5-02 / PK-SPEC-P5 §2.1・§9）。
 *
 * ── 見ているもの ────────────────────────────────────────
 *   `billing.write` を持たないロールが **404** になること（403 ではない）
 *   コードの重複が **409**、形の誤りが **400** で分かれること
 *   越境した `counterpartyId` が **404** になり、DB へ届かないこと
 *   作成・更新が `AuditLog` に残ること（security.md §6 / CLAUDE.md §5）
 *   **物理削除の口が無いこと**（CLAUDE.md §4）
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * schema/invoice.ts の `counterparty` の宣言順。** 列を足す task はここも直すこと。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import counterparties from "./counterparties.js";

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
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_COUNTERPARTY_ID = `${OTHER_ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

type TestRole = "ORG_ADMIN" | "PROPERTY_MANAGER" | "INSPECTOR" | "AUDITOR";

function deps(role: TestRole): TenantDeps {
  return {
    findMembershipByUserId: () => Promise.resolve({ id: MEMBERSHIP_ID, role, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `counterparty` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function counterpartyRow(overrides: { isActive?: number } = {}): unknown[] {
  return [
    COUNTERPARTY_ID,
    ORGANIZATION_ID,
    "CP-001",
    "サンプルホテル運営株式会社",
    null, // display_name
    "T1234567890123",
    "1000001",
    "東京都千代田区1-1-1",
    null, // address2
    "経理部",
    "山田",
    "keiri@example.co.jp",
    "[]", // cc_emails（JSON）
    31,
    30,
    "FLOOR",
    overrides.isActive ?? 1,
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
  api.route("/counterparties", counterparties);
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
  code: "CP-001",
  legalName: "サンプルホテル運営株式会社",
  billingEmail: "keiri@example.co.jp",
  ccEmails: ["manager@example.co.jp"],
  closingDay: 31,
  paymentTermDays: 30,
  taxRoundingMode: "FLOOR" as const,
};

describe("GET /api/v1/counterparties", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();

    const res = await ctx.app.request("/api/v1/counterparties", {}, ctx.env);

    expect(res.status).toBe(401);
  });

  it("INSPECTOR は 404（security.md §1「請求情報を見られない」）", async () => {
    const ctx = setup("INSPECTOR");
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      "/api/v1/counterparties",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(404);
  });

  it("既定では無効化済みも返す（設定を編むための口のため）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow({ isActive: 0 })]);

    const res = await ctx.app.request(
      "/api/v1/counterparties",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(200);
    const select = ctx.d1.queries.find((query) => query.sql.includes('from "counterparty"'));
    expect(select?.sql).not.toContain('"is_active" = ?');
  });

  it("isActive=true を渡すと絞り込みが載る", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    await ctx.app.request(
      "/api/v1/counterparties?isActive=true",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    const select = ctx.d1.queries.find((query) => query.sql.includes('from "counterparty"'));
    expect(select?.sql).toContain('"is_active" = ?');
  });

  it("isActive の値が true / false 以外なら 400", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await ctx.app.request(
      "/api/v1/counterparties?isActive=yes",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(res.status).toBe(400);
  });

  it("応答に organizationId を含めない", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    const res = await ctx.app.request(
      "/api/v1/counterparties",
      { headers: { Cookie: cookie } },
      ctx.env,
    );

    expect(JSON.stringify(await res.json())).not.toContain(ORGANIZATION_ID);
  });
});

describe("POST /api/v1/counterparties", () => {
  it("作成でき、監査ログが残る（CLAUDE.md §5）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]); // 重複チェックの一覧
    ctx.d1.enqueueRows([]); // upsert の既存チェック

    const res = await send(ctx, "/api/v1/counterparties", "POST", VALID, cookie);

    expect(res.status).toBe(201);
    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(JSON.stringify(audit?.params)).toContain("counterparty.created");
  });

  it("監査ログに住所・担当者名を残さない（必要のない個人の情報を積まない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);

    await send(
      ctx,
      "/api/v1/counterparties",
      "POST",
      { ...VALID, address1: "東京都千代田区1-1-1", contactName: "山田" },
      cookie,
    );

    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(JSON.stringify(audit?.params)).not.toContain("山田");
    expect(JSON.stringify(audit?.params)).not.toContain("千代田");
  });

  it("コードが既存とぶつかったら 409（黙って上書きしない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    const res = await send(ctx, "/api/v1/counterparties", "POST", VALID, cookie);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "DUPLICATE_CODE" });
  });

  it.each([
    ["メールの形が違う", { ...VALID, billingEmail: "not-an-email" }],
    ["登録番号の形が違う", { ...VALID, invoiceRegistrationNo: "1234567890123" }],
    ["締め日が範囲外", { ...VALID, closingDay: 32 }],
    ["支払サイトが負", { ...VALID, paymentTermDays: -1 }],
    ["コードに使えない文字", { ...VALID, code: "CP,001" }],
    ["CC が 11 件", { ...VALID, ccEmails: Array.from({ length: 11 }, (_v, i) => `x${String(i)}@e.jp`) }],
  ])("%s なら 400", async (_label, body) => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, "/api/v1/counterparties", "POST", body, cookie);

    expect(res.status).toBe(400);
  });

  it("登録番号の空文字は null に落ちる（「設定済みだが空」を作らない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);

    const res = await send(
      ctx,
      "/api/v1/counterparties",
      "POST",
      { ...VALID, invoiceRegistrationNo: "" },
      cookie,
    );

    expect(res.status).toBe(201);
    const insert = ctx.d1.queries.find((query) => query.sql.includes('insert into "counterparty"'));
    expect(insert?.params).toContain(null);
  });

  it.each([["PROPERTY_MANAGER"], ["AUDITOR"], ["INSPECTOR"]] as const)(
    "%s は書き込めない（404）",
    async (role) => {
      const ctx = setup(role);
      const cookie = await ctx.cookie();

      const res = await send(ctx, "/api/v1/counterparties", "POST", VALID, cookie);

      expect(res.status).toBe(404);
    },
  );
});

describe("PATCH /api/v1/counterparties/:counterpartyId", () => {
  it("更新でき、監査ログが残る", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    const res = await send(
      ctx,
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      "PATCH",
      { billingEmail: "new@example.co.jp" },
      cookie,
    );

    expect(res.status).toBe(200);
    const audit = ctx.d1.queries.find((query) => query.sql.includes("audit_log"));
    expect(JSON.stringify(audit?.params)).toContain("counterparty.updated");
  });

  it("無効化は PATCH { isActive: false }（DELETE ではない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    const res = await send(
      ctx,
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      "PATCH",
      { isActive: false },
      cookie,
    );

    expect(res.status).toBe(200);
    const update = ctx.d1.queries.find((query) => query.sql.includes('update "counterparty"'));
    expect(update?.sql).toContain('"is_active"');
  });

  it("越境した ID は 404。**DB へ届かない**", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(
      ctx,
      `/api/v1/counterparties/${OTHER_COUNTERPARTY_ID}`,
      "PATCH",
      { billingEmail: "x@example.co.jp" },
      cookie,
    );

    expect(res.status).toBe(404);
    expect(ctx.d1.queries.some((query) => query.sql.includes('from "counterparty"'))).toBe(false);
  });

  it("存在しない ID は 404", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([]);

    const res = await send(
      ctx,
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      "PATCH",
      { billingEmail: "x@example.co.jp" },
      cookie,
    );

    expect(res.status).toBe(404);
  });

  it("code は受け付けない（鍵の付け替えをさせない）", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();
    ctx.d1.enqueueRows([counterpartyRow()]);

    await send(
      ctx,
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      "PATCH",
      { code: "CP-999" },
      cookie,
    );

    const update = ctx.d1.queries.find((query) => query.sql.includes('update "counterparty"'));
    expect(update?.sql).not.toContain('"code" =');
  });
});

describe("物理削除の口が無い（CLAUDE.md §4）", () => {
  it("DELETE は 404", async () => {
    const ctx = setup();
    const cookie = await ctx.cookie();

    const res = await send(ctx, `/api/v1/counterparties/${COUNTERPARTY_ID}`, "DELETE", {}, cookie);

    expect(res.status).toBe(404);
  });
});
