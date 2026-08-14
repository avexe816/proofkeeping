/**
 * 差異レポート API の配線（P4-06 / P4-07 / PK-SPEC-P4 §6.1〜§6.4）。
 *
 * ルール: .claude/rules/security.md §1 / .claude/rules/testing.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **`CLEANER` / `INSPECTOR` が 404**（§6.4 MUST / security.md §1）
 *   - **施設責任者は読めるが閉じられない**（§6.4 の表）
 *   - 「全施設」は組織全体を読める相手だけ（`ORGANIZATION_TARGET`）
 *   - 解決コードの組み合わせ（§6.3）。`OTHER` は理由必須
 *   - 差異を作る口・消す口が存在しない
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import findings from "./findings.js";

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
const FINDING_ID = `${ORG_SHORT_ID}__find_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
/** 別組織の差異。**越境 ID は DB へ行く前に落ちる。** */
const OTHER_FINDING_ID = `z9y8x7__find_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "OWNER", isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
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
  api.route("/findings", findings);
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
  return ctx.app.request(
    path,
    { headers: cookie === null ? {} : { Cookie: cookie } },
    ctx.env,
  );
}

async function patch(
  ctx: Ctx,
  findingId: string,
  body: unknown,
  cookie: string,
): Promise<Response> {
  return ctx.app.request(
    `/api/v1/findings/${findingId}/status`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe("GET /api/v1/findings — 一覧（§6.1）", () => {
  it("セッションが無ければ 401", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/findings", null)).status).toBe(401);
  });

  it("`CLEANER` は 404（§6.4 MUST / security.md §1）", async () => {
    const ctx = setup("CLEANER");
    const res = await get(ctx, `/api/v1/findings?propertyId=${PROPERTY_ID}`, await ctx.cookie());
    expect(res.status).toBe(404);
    // **DB へ 1 件も行かない。** 存在を推し量れる差を作らない。
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`INSPECTOR` も 404", async () => {
    const ctx = setup("INSPECTOR");
    const res = await get(ctx, `/api/v1/findings?propertyId=${PROPERTY_ID}`, await ctx.cookie());
    expect(res.status).toBe(404);
  });

  it("`ORG_ADMIN` は施設を指定せずに読める（全施設）", async () => {
    const ctx = setup("ORG_ADMIN");
    const res = await get(ctx, "/api/v1/findings", await ctx.cookie());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [], suppressedCount: 0 });
  });

  it("`PROPERTY_MANAGER` は全施設を読めない（§6.4 の △）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    expect((await get(ctx, "/api/v1/findings", await ctx.cookie())).status).toBe(404);
  });

  it("`PROPERTY_MANAGER` も担当施設を指定すれば読める", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await get(ctx, `/api/v1/findings?propertyId=${PROPERTY_ID}`, await ctx.cookie());
    expect(res.status).toBe(200);
  });

  it("`AUDITOR` は読める（読取専用）", async () => {
    const ctx = setup("AUDITOR");
    expect((await get(ctx, "/api/v1/findings", await ctx.cookie())).status).toBe(200);
  });

  it("業務日の形が違えば 400", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/findings?from=2026-9-1", await ctx.cookie())).status).toBe(400);
  });

  it("語彙に無い状態は 400（黙って全件にしない）", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/findings?status=UNKNOWN", await ctx.cookie())).status).toBe(400);
  });

  it("語彙に無い重要度も 400", async () => {
    const ctx = setup();
    expect((await get(ctx, "/api/v1/findings?severity=CRITICAL", await ctx.cookie())).status).toBe(
      400,
    );
  });

  it("状態は複数指定できる", async () => {
    const ctx = setup();
    const res = await get(ctx, "/api/v1/findings?status=OPEN,REVIEWING", await ctx.cookie());
    expect(res.status).toBe(200);
  });
});

describe("GET /api/v1/findings/:id — 詳細（§6.2）", () => {
  it("存在しない差異は 404", async () => {
    const ctx = setup();
    expect((await get(ctx, `/api/v1/findings/${FINDING_ID}`, await ctx.cookie())).status).toBe(404);
  });

  it("別組織の差異は DB へ行く前に 404", async () => {
    const ctx = setup();
    const res = await get(ctx, `/api/v1/findings/${OTHER_FINDING_ID}`, await ctx.cookie());
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`CLEANER` は 404", async () => {
    const ctx = setup("CLEANER");
    expect((await get(ctx, `/api/v1/findings/${FINDING_ID}`, await ctx.cookie())).status).toBe(404);
  });
});

describe("PATCH /api/v1/findings/:id/status — 状態の変更（§6.3）", () => {
  it("`PROPERTY_MANAGER` は閉じられない（読めるが 404）", async () => {
    const ctx = setup("PROPERTY_MANAGER");
    const res = await patch(ctx, FINDING_ID, { status: "REVIEWING" }, await ctx.cookie());
    expect(res.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });

  it("`AUDITOR` は書き込めない（security.md §1）", async () => {
    const ctx = setup("AUDITOR");
    const res = await patch(ctx, FINDING_ID, { status: "REVIEWING" }, await ctx.cookie());
    expect(res.status).toBe(404);
  });

  it("`RESOLVED` は解決コードが必須（§6.3）", async () => {
    const ctx = setup();
    const res = await patch(ctx, FINDING_ID, { status: "RESOLVED" }, await ctx.cookie());
    expect(res.status).toBe(400);
  });

  it("`RESOLVED` に誤検知側のコードは通らない", async () => {
    const ctx = setup();
    const res = await patch(
      ctx,
      FINDING_ID,
      { status: "RESOLVED", resolutionCode: "DATA_ERROR" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("`OTHER` は理由が必須（§6.3「その他（理由必須）」）", async () => {
    const ctx = setup();
    const res = await patch(
      ctx,
      FINDING_ID,
      { status: "RESOLVED", resolutionCode: "OTHER", resolutionNote: "   " },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("`REVIEWING` に解決コードは付けられない", async () => {
    const ctx = setup();
    const res = await patch(
      ctx,
      FINDING_ID,
      { status: "REVIEWING", resolutionCode: "RECORD_MISSING" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(400);
  });

  it("`SUPPRESSED` へは動かせない（抑制は照合の仕事 / §4.1）", async () => {
    const ctx = setup();
    const res = await patch(ctx, FINDING_ID, { status: "SUPPRESSED" }, await ctx.cookie());
    expect(res.status).toBe(400);
  });

  it("存在しない差異は 404（形が正しくても）", async () => {
    const ctx = setup();
    const res = await patch(
      ctx,
      FINDING_ID,
      { status: "RESOLVED", resolutionCode: "RECORD_MISSING" },
      await ctx.cookie(),
    );
    expect(res.status).toBe(404);
  });

  it("壊れた JSON は 400（500 にしない）", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      `/api/v1/findings/${FINDING_ID}/status`,
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

describe("差異を作る口・消す口が無い（§5.3 / §6）", () => {
  it("POST /api/v1/findings は 404", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      "/api/v1/findings",
      { method: "POST", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /api/v1/findings/:id は 404", async () => {
    const ctx = setup();
    const res = await ctx.app.request(
      `/api/v1/findings/${FINDING_ID}`,
      { method: "DELETE", headers: { Cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(res.status).toBe(404);
  });
});
