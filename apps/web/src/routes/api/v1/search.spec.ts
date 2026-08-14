/**
 * 電子帳簿保存法の検索要件（P5-11 / PK-SPEC-P5 §1.2 MUST・§9）。
 *
 * ルール: .claude/rules/billing.md §2
 *
 * ── 見ているもの ────────────────────────────────────────
 * §1.2 MUST「取引年月日・取引金額・取引先の 3 項目で検索できる」。
 * **3 つを組み合わせて 1 本のクエリになること**を、発行される SQL の
 * 束縛値で確かめる（一覧の中身ではなく、条件が落ちていないこと）。
 *
 * 請求書と領収書の両方に同じ検査を掛ける。**片方だけ通っても
 * 要件は満たされない**（どちらも電子取引の記録）。
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

function deps(): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: "ORG_ADMIN" as const, isActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

function setup(): { app: Hono<AppEnv>; env: Env; d1: FakeD1; cookie: () => Promise<string> } {
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
  useTenantMiddleware(api, deps());
  api.route("/invoices", invoices);
  api.route("/receipts", receipts);
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

/** 3 条件を組み合わせた検索を 1 回投げ、発行された SQL を返す。 */
async function search(
  path: string,
): Promise<{ sql: string; params: unknown[] }> {
  const ctx = setup();
  ctx.d1.enqueueRows([]);
  await ctx.app.request(path, { headers: { cookie: await ctx.cookie() } }, ctx.env);
  const query = ctx.d1.queries[0];
  return { sql: query?.sql ?? "", params: query?.params ?? [] };
}

describe.each([
  ["請求書", "invoices"],
  ["領収書", "receipts"],
])("%s: 電子帳簿保存法の 3 項目（§1.2 MUST）", (_label, resource) => {
  it("**3 条件を組み合わせて 1 本のクエリになる**", async () => {
    const { params } = await search(
      `/api/v1/${resource}?from=2026-09-01&to=2026-10-31&minAmount=1000&maxAmount=999999&counterparty=${encodeURIComponent(
        "サンプルホテル",
      )}`,
    );

    // 取引年月日
    expect(params).toContain("2026-09-01");
    expect(params).toContain("2026-10-31");
    // 取引金額
    expect(params).toContain(1000);
    expect(params).toContain(999999);
    // 取引先（**名前で引く**）
    expect(params).toContain("%サンプルホテル%");
  });

  it("取引先だけでも引ける", async () => {
    const { params } = await search(`/api/v1/${resource}?counterparty=${encodeURIComponent("サンプル")}`);
    expect(params).toContain("%サンプル%");
  });

  it("取引年月日だけでも引ける", async () => {
    const { params } = await search(`/api/v1/${resource}?from=2026-09-01`);
    expect(params).toContain("2026-09-01");
  });

  it("取引金額だけでも引ける", async () => {
    const { params } = await search(`/api/v1/${resource}?minAmount=500`);
    expect(params).toContain(500);
  });

  it("**発行時に固定した名前で引く**（マスタと JOIN しない）", async () => {
    const { sql } = await search(`/api/v1/${resource}?counterparty=${encodeURIComponent("サンプル")}`);
    // 名前は帳票側の非正規化列（§1.2 のための列）。取引先マスタを
    // 引きに行くと、名前を変えた瞬間に過去の帳票が引けなくなる。
    expect(sql).toContain("counterparty_name");
    expect(sql).not.toContain("join");
  });

  it("組織の条件が必ず載る（テナント分離の第 1 層）", async () => {
    const { sql, params } = await search(`/api/v1/${resource}?counterparty=x`);
    expect(sql).toContain("organization_id");
    expect(params).toContain(ORGANIZATION_ID);
  });

  it("金額が数値でなければ 400（黙って無視しない）", async () => {
    const ctx = setup();
    const response = await ctx.app.request(
      `/api/v1/${resource}?minAmount=１０００`,
      { headers: { cookie: await ctx.cookie() } },
      ctx.env,
    );
    expect(response.status).toBe(400);
    expect(ctx.d1.queries).toHaveLength(0);
  });

  it("条件を何も付けなければ全件（絞り込みの束縛値が無い）", async () => {
    const { params } = await search(`/api/v1/${resource}`);
    // 組織 ID と limit だけ。
    expect(params).toContain(ORGANIZATION_ID);
    expect(params.some((value) => typeof value === "string" && value.startsWith("%"))).toBe(false);
  });
});
