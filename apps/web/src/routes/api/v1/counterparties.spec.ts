/**
 * 取引先 API の配線（P5-02 / PK-SPEC-P5 §2.1）。
 *
 * ルール: .claude/rules/security.md §1 / .claude/rules/billing.md §1
 *         .claude/rules/testing.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 読みは `billing.read` と同じ配り方（`INSPECTOR` / `CLEANER` は 404）
 *   - **書けるのは `OWNER` / `ORG_ADMIN` だけ**（`PROPERTY_MANAGER` は 404）
 *   - `AUDITOR` は読めるが書けない
 *   - **消す口が無い**（HTTP メソッドとして DELETE を持たない）
 *   - 締め日・支払サイト・端数処理・請求先メール・CC が通ること（完了条件）
 *   - 登録番号は **形式だけ** 見る（実在は確かめない）
 *   - コードの重複は 409、付け替えは 400
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
const COUNTERPARTY_ID = `${ORG_SHORT_ID}__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
/** **別組織の ID。** 404 になること（403 にしない / security.md §1）。 */
const OTHER_COUNTERPARTY_ID = "z9y8x7__cp_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "OWNER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `counterparty` の 1 行。**列の順序は schema/invoice.ts の宣言順。** */
function counterpartyRow(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const row: Record<string, unknown> = {
    id: COUNTERPARTY_ID,
    organizationId: ORGANIZATION_ID,
    code: "CP001",
    legalName: "サンプル清掃株式会社",
    displayName: null,
    invoiceRegistrationNo: null,
    postalCode: null,
    address1: null,
    address2: null,
    department: null,
    contactName: null,
    billingEmail: "billing@example.com",
    ccEmails: "[]",
    closingDay: 31,
    paymentTermDays: 30,
    taxRoundingMode: "FLOOR",
    isActive: 1,
    createdAt: NOW.getTime(),
    updatedAt: NOW.getTime(),
    ...overrides,
  };
  return Object.values(row);
}

const VALID_BODY = {
  code: "CP001",
  legalName: "サンプル清掃株式会社",
  billingEmail: "billing@example.com",
  ccEmails: ["keiri@example.com"],
  closingDay: 20,
  paymentTermDays: 45,
  taxRoundingMode: "CEIL",
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

describe("GET /api/v1/counterparties — 一覧（§2.1）", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/counterparties", null)).status).toBe(401);
  });

  it("`ORG_ADMIN` は読める", async () => {
    const ctx = setup("ORG_ADMIN");
    ctx.d1.enqueueRows([counterpartyRow()]);

    const res = await get(ctx, "/api/v1/counterparties", await ctx.cookie());
    expect(res.status).toBe(200);
    const body: { data: { code: string; isQualifiedIssuer: boolean }[] } = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.code).toBe("CP001");
  });

  it("**登録番号が無ければ `isQualifiedIssuer` は偽**（billing.md §1）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    const res = await get(ctx, "/api/v1/counterparties", await ctx.cookie());
    const body: { data: { isQualifiedIssuer: boolean }[] } = await res.json();
    expect(body.data[0]?.isQualifiedIssuer).toBe(false);
  });

  it("登録番号があれば真（画面に判定を持たせない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow({ invoiceRegistrationNo: "T1234567890123" })]);
    const res = await get(ctx, "/api/v1/counterparties", await ctx.cookie());
    const body: { data: { isQualifiedIssuer: boolean }[] } = await res.json();
    expect(body.data[0]?.isQualifiedIssuer).toBe(true);
  });

  it("**`INSPECTOR` は 404**（請求情報を見られない / security.md §1）", async () => {
    const ctx = setup("INSPECTOR");
    const res = await get(ctx, "/api/v1/counterparties", await ctx.cookie());
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`CLEANER` も 404", async () => {
    const ctx = setup("CLEANER");
    expect((await get(ctx, "/api/v1/counterparties", await ctx.cookie())).status).toBe(404);
  });

  it("`AUDITOR` は読める（読取専用）", async () => {
    const ctx = setup("AUDITOR");
    ctx.d1.enqueueRows([counterpartyRow()]);
    expect((await get(ctx, "/api/v1/counterparties", await ctx.cookie())).status).toBe(200);
  });

  it("`isActive` に真偽以外を渡せば 400", async () => {
    const ctx = setup();
    const res = await get(ctx, "/api/v1/counterparties?isActive=yes", await ctx.cookie());
    expect(res.status).toBe(400);
    expect(ctx.d1.queries).toEqual([]);
  });
});

describe("GET /api/v1/counterparties/:id — 1 件", () => {
  it("**別組織の ID は 404**（403 にしない）", async () => {
    const ctx = setup();
    const res = await get(
      ctx,
      `/api/v1/counterparties/${OTHER_COUNTERPARTY_ID}`,
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
    // ID の照合は DB へ行く前（architecture.md §2 第 2 層）。
    expect(ctx.d1.queries).toEqual([]);
  });

  it("行が無ければ 404", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    expect(
      (await get(ctx, `/api/v1/counterparties/${COUNTERPARTY_ID}`, await ctx.cookie())).status,
    ).toBe(404);
  });
});

describe("POST /api/v1/counterparties — 登録（§2.1 / P5-02 の完了条件）", () => {
  it("**締め日・支払サイト・端数処理が通る**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]); // 重複確認（listCounterparties）
    ctx.d1.enqueueRows([]); // upsert の既存確認
    ctx.d1.enqueueRows([counterpartyRow({ closingDay: 20, paymentTermDays: 45, taxRoundingMode: "CEIL" })]);

    const res = await send(ctx, "POST", "/api/v1/counterparties", VALID_BODY, await ctx.cookie());
    expect(res.status).toBe(201);
    const body: { data: { closingDay: number; paymentTermDays: number; taxRoundingMode: string } } =
      await res.json();
    expect(body.data).toMatchObject({
      closingDay: 20,
      paymentTermDays: 45,
      taxRoundingMode: "CEIL",
    });
  });

  it("**請求先メールと CC が登録できる**", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([counterpartyRow({ ccEmails: '["keiri@example.com"]' })]);

    const res = await send(ctx, "POST", "/api/v1/counterparties", VALID_BODY, await ctx.cookie());
    const body: { data: { billingEmail: string; ccEmails: string[] } } = await res.json();
    expect(body.data.billingEmail).toBe("billing@example.com");
    expect(body.data.ccEmails).toEqual(["keiri@example.com"]);
  });

  it("請求先メールが無ければ 400", async () => {
    const ctx = setup();
    // 分割代入で落とすと未使用の変数が残る。**鍵を消す形にする。**
    const body: Record<string, unknown> = { ...VALID_BODY };
    delete body["billingEmail"];
    const res = await send(ctx, "POST", "/api/v1/counterparties", body, await ctx.cookie());
    expect(res.status).toBe(400);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("メールの形をしていなければ 400", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/counterparties",
      { ...VALID_BODY, billingEmail: "not-an-email" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("CC が 10 件を超えれば 400", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/counterparties",
      {
        ...VALID_BODY,
        ccEmails: Array.from({ length: 11 }, (_unused, i) => `cc${String(i)}@example.com`),
      },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("締め日が 32 なら 400", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/counterparties",
      { ...VALID_BODY, closingDay: 32 },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("**登録番号は形だけ見る**（`T` + 13 桁でなければ 400）", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "POST",
      "/api/v1/counterparties",
      { ...VALID_BODY, invoiceRegistrationNo: "T123" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("登録番号が未設定でも作れる（適格請求書でなくなるだけ）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([]);
    ctx.d1.enqueueRows([counterpartyRow()]);
    const res = await send(ctx, "POST", "/api/v1/counterparties", VALID_BODY, await ctx.cookie());
    expect(res.status).toBe(201);
  });

  it("**同じコードは 409**（黙って上書きしない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    const res = await send(ctx, "POST", "/api/v1/counterparties", VALID_BODY, await ctx.cookie());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "DUPLICATE_CODE" });
  });

  it("**`PROPERTY_MANAGER` は書けない**（404）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await send(ctx, "POST", "/api/v1/counterparties", VALID_BODY, await ctx.cookie());
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("**`AUDITOR` は書けない**（security.md §1）", async () => {
    const ctx = setup("AUDITOR");
    expect(
      (await send(ctx, "POST", "/api/v1/counterparties", VALID_BODY, await ctx.cookie())).status,
    ).toBe(404);
  });

  it("壊れた JSON は 400（500 にしない）", async () => {
    const ctx = setup();
    const res = await send(ctx, "POST", "/api/v1/counterparties", "{", await ctx.cookie());
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/v1/counterparties/:id — 更新（§2.1）", () => {
  it("更新できる", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]); // before
    ctx.d1.enqueueRows([counterpartyRow()]); // upsert の既存確認
    ctx.d1.enqueueRows([counterpartyRow({ closingDay: 20 })]); // after

    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      VALID_BODY,
      await ctx.cookie(),
    );
    expect(res.status).toBe(200);
  });

  it("**コードは付け替えられない**（400）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([counterpartyRow()]);
    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      { ...VALID_BODY, code: "CP999" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("別組織の ID は 404", async () => {
    const ctx = setup();
    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/counterparties/${OTHER_COUNTERPARTY_ID}`,
      VALID_BODY,
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`PROPERTY_MANAGER` は 404", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await send(
      ctx,
      "PATCH",
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      VALID_BODY,
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
  });
});

describe("消す口が無い（PK-SPEC-P0 §24.4 と同じ方針）", () => {
  it("**DELETE は 404**（取引終了は `isActive = false`）", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      `/api/v1/counterparties/${COUNTERPARTY_ID}`,
      { method: "DELETE", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });
});
