/**
 * 日報 API の配線（P2-14）。
 *
 * 仕様: docs/PK-SPEC-P2.md §9・§14.4
 * ルール: .claude/rules/security.md §1
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 生成が**必ず Queue を通る**（完了条件「Queue コンシューマ内で生成」）
 *   - 再生成が**旧版を消さない**（版を上げる要求として投入される / §9.3）
 *   - **現場ロール（`CLEANER` / `INSPECTOR`）が日報に到達できない**（404）
 *   - 一覧・詳細が `storageKey` を返さない（R2 のキー体系を外へ出さない）
 * 集計そのものは `packages/engine` の dailyReport.spec.ts が押さえる。
 *
 * ── 代役の行は位置で組む ────────────────────────────────
 * `createFakeD1()` の `raw()` はそのまま drizzle へ渡る。**列の順序は
 * スキーマの宣言順。** 列を足す task はここも直すこと。
 */

import type { Env } from "@pk/db";
import { createFakeD1, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../../lib/auth/cookie.js";
import { createSession } from "../../../lib/auth/session.js";
import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { useTenantMiddleware, type AppEnv, type TenantDeps } from "../../../middleware/index.js";

import reports from "./reports.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-09-11T05:10:00.000Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const ORG_SHORT_ID = "a1b2c3";
const ORGANIZATION_ID = "org_test_alpha";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ZZZZZZZZ`;
const USER_ID = `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const PROPERTY_ID = `${ORG_SHORT_ID}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const REPORT_ID = `${ORG_SHORT_ID}__rpt_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_ORG_REPORT_ID = `zz9zz9__rpt_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const STORAGE_KEY = `documents/${ORGANIZATION_ID}/${PROPERTY_ID}/daily-reports/2026/09/RPT-2026-0042-r1.pdf`;

function depsFor(role: string): TenantDeps {
  return {
    findMembershipByUserId: () =>
      Promise.resolve({ id: MEMBERSHIP_ID, role: role as "ORG_ADMIN", isEffectiveActive: true }),
    listAssignedPropertyIds: () => Promise.resolve([PROPERTY_ID]),
  };
}

/** `daily_report` の 1 行。**列の順序は schema/dailyReport.ts の宣言順。** */
function reportRow(revision = 1): unknown[] {
  return [
    REPORT_ID,
    ORGANIZATION_ID,
    PROPERTY_ID,
    "2026-09-10",
    "RPT-2026-0042",
    revision,
    STORAGE_KEY,
    "a".repeat(64),
    "b".repeat(64),
    52,
    50,
    6,
    2,
    1,
    NOW.getTime(),
    null,
    null,
  ];
}

/** `property` の 1 行。**列の順序は schema/property.ts の宣言順。** */
function propertyRow(): unknown[] {
  return [
    PROPERTY_ID,
    ORGANIZATION_ID,
    "HTLA",
    "テスト施設",
    "Asia/Tokyo",
    "05:00",
    1,
    null,
    null,
    0,
    1,
    0,
    0,
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
    QUEUE_PDF_GENERATION: {
      send: (message: unknown) => {
        queued.push(message);
        return Promise.resolve();
      },
    },
    DOCUMENTS: {
      head: () => Promise.resolve({ size: 1234 }),
    },
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  const api = new Hono<AppEnv>();
  useTenantMiddleware(api, depsFor(role));
  api.route("/reports", reports);
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

async function request(
  ctx: Ctx,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> {
  return ctx.app.request(
    path,
    {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    ctx.env,
  );
}

describe("一覧・詳細", () => {
  it("一覧は施設と業務日の範囲で引ける", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([reportRow()]);

    const response = await request(
      ctx,
      "GET",
      `/api/v1/reports/daily?propertyId=${PROPERTY_ID}&from=2026-09-01&to=2026-09-30`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);

    const body: { data: { documentNo: string }[] } = await response.json();
    expect(body.data[0]?.documentNo).toBe("RPT-2026-0042");
  });

  it("施設 ID が無ければ 400", async () => {
    const ctx = setup();
    const response = await request(ctx, "GET", "/api/v1/reports/daily", await ctx.cookie());
    expect(response.status).toBe(400);
  });

  it("R2 のキーを応答に出さない", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([reportRow()]);

    const response = await request(
      ctx,
      "GET",
      `/api/v1/reports/daily/${REPORT_ID}`,
      await ctx.cookie(),
    );
    const text = await response.text();
    expect(text).not.toContain("documents/");
    expect(text).not.toContain("storageKey");
  });

  it("別組織の日報 ID は DB へ行く前に 404", async () => {
    const ctx = setup();
    const response = await request(
      ctx,
      "GET",
      `/api/v1/reports/daily/${OTHER_ORG_REPORT_ID}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
    expect(ctx.d1.queries).toEqual([]);
  });
});

describe("生成は必ず Queue を通る", () => {
  it("生成の要求は 202 とキュー投入（PDF をその場で作らない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([propertyRow()]);

    const response = await request(
      ctx,
      "POST",
      "/api/v1/reports/daily/generate",
      await ctx.cookie(),
      { propertyId: PROPERTY_ID, businessDate: "2026-09-10" },
    );

    expect(response.status).toBe(202);
    expect(ctx.queued).toHaveLength(1);
    expect(ctx.queued[0]).toMatchObject({
      kind: "DAILY_REPORT",
      propertyId: PROPERTY_ID,
      businessDate: "2026-09-10",
      mode: "MANUAL",
      requestedById: MEMBERSHIP_ID,
      requestedAtMs: NOW.getTime(),
    });
  });

  it("再生成は対象の日報の施設・業務日で投入する（本文を取らない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([reportRow()]);

    const response = await request(
      ctx,
      "POST",
      `/api/v1/reports/daily/${REPORT_ID}/regenerate`,
      await ctx.cookie(),
    );

    expect(response.status).toBe(202);
    expect(ctx.queued[0]).toMatchObject({
      propertyId: PROPERTY_ID,
      businessDate: "2026-09-10",
      mode: "MANUAL",
    });
  });

  it("業務日の形式が違えば 400（キューへ載せない）", async () => {
    const ctx = setup();
    const response = await request(
      ctx,
      "POST",
      "/api/v1/reports/daily/generate",
      await ctx.cookie(),
      { propertyId: PROPERTY_ID, businessDate: "2026/09/10" },
    );
    expect(response.status).toBe(400);
    expect(ctx.queued).toEqual([]);
  });

  it("施設が無ければ 404（キューへ載せない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([]);

    const response = await request(
      ctx,
      "POST",
      "/api/v1/reports/daily/generate",
      await ctx.cookie(),
      { propertyId: PROPERTY_ID, businessDate: "2026-09-10" },
    );
    expect(response.status).toBe(404);
    expect(ctx.queued).toEqual([]);
  });
});

describe("ダウンロード", () => {
  it("署名付き URL を返す（PDF の実体をこの経路で流さない）", async () => {
    const ctx = setup();
    ctx.d1.enqueueRows([reportRow()]);

    const response = await request(
      ctx,
      "GET",
      `/api/v1/reports/daily/${REPORT_ID}/download`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);

    const body: { url: string; pdfSha256: string } = await response.json();
    expect(body.url).toContain("/api/v1/files/");
    expect(body.url).toContain("sig=");
    expect(body.pdfSha256).toBe("b".repeat(64));
  });
});

describe("現場ロールは日報へ到達できない（security.md §1）", () => {
  it.each([
    ["CLEANER", "一覧"],
    ["INSPECTOR", "一覧"],
  ])("%s は %s で 404", async (role) => {
    const ctx = setup(role);
    const response = await request(
      ctx,
      "GET",
      `/api/v1/reports/daily?propertyId=${PROPERTY_ID}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(404);
  });

  it.each([["CLEANER"], ["INSPECTOR"], ["VENDOR_ADMIN"]])(
    "%s は生成できない（404）",
    async (role) => {
      const ctx = setup(role);
      ctx.d1.enqueueRows([propertyRow()]);

      const response = await request(
        ctx,
        "POST",
        "/api/v1/reports/daily/generate",
        await ctx.cookie(),
        { propertyId: PROPERTY_ID, businessDate: "2026-09-10" },
      );
      expect(response.status).toBe(404);
      expect(ctx.queued).toEqual([]);
    },
  );

  it("VENDOR_ADMIN は閲覧できる（提出する側 / §9.1）", async () => {
    const ctx = setup("VENDOR_ADMIN");
    ctx.d1.enqueueRows([reportRow()]);

    const response = await request(
      ctx,
      "GET",
      `/api/v1/reports/daily?propertyId=${PROPERTY_ID}`,
      await ctx.cookie(),
    );
    expect(response.status).toBe(200);
  });
});
