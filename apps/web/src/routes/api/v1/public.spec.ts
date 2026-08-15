/**
 * 公開 API（P6-12 / PK-SPEC-P6 §6）。
 *
 * ルール: .claude/rules/security.md §1・§7 / testing.md §2
 *
 * 完了条件（`docs/tasks/P6-12.md`）のうち、ここが押さえるもの:
 *   - **キーが作成時のみ全体表示される**（再表示の口が無い）
 *   - 7 スコープが機能する（足りなければ 403）
 *   - `propertyIds` 制限が機能する
 *   - レート制限が機能する（バケットが宣言されている）
 *
 * ── 構造で押さえているもの ──────────────────────────────
 * 「公開 API で `assertPermission()` を呼ばない」（DECISIONS #151）は
 * **振る舞いのテストでは押さえきれない。** 1 か所で呼ばれても他が緑なら
 * 通ってしまう。ソースを走査して依存の不在を固定する。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { generateId } from "@pk/db";
import { createFakeD1, createFakeEnv, TEST_ORG, type FakeD1 } from "@pk/db/test-support";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { issueApiKey } from "../../../lib/auth/apiKey.js";
import { RATE_LIMITS } from "../../../lib/auth/rateLimit.js";
import {
  apiKeyMiddleware,
  getApiKey,
  isPropertyAllowed,
  requireScope,
  type PublicApiEnv,
} from "../../../middleware/apiKey.js";

const API_KEY_ID = generateId(TEST_ORG.orgShortId, "akey");
const PROPERTY_A = generateId(TEST_ORG.orgShortId, "prop");
const PROPERTY_B = generateId(TEST_ORG.orgShortId, "prop");

/** ソースを読む（相対は `import.meta.url` 起点）。 */
function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * コメントを落としたソース。
 *
 * **注記そのものが検査に引っかかるのを避ける。** `public.ts` の冒頭は
 * 「`assertPermission()` を呼ばない」と書いてあり、素のまま走査すると
 * その一文が「呼んでいる」ことになってしまう。
 */
function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** KV の代わり。**レート制限のカウンタを持つだけ。** */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

/** `api_key` の 1 行。列順は schema の宣言順。 */
function apiKeyRow(options: {
  scopes: string[];
  propertyIds: string[] | null;
  expiresAt?: number | null;
  revokedAt?: number | null;
}): unknown[] {
  return [
    API_KEY_ID,
    TEST_ORG.organizationId,
    "テスト用",
    `pk_live_${TEST_ORG.orgShortId}`,
    "dummy-hash",
    JSON.stringify(options.scopes),
    options.propertyIds === null ? null : JSON.stringify(options.propertyIds),
    null,
    options.expiresAt ?? null,
    options.revokedAt ?? null,
    generateId(TEST_ORG.orgShortId, "mem"),
    Date.parse("2026-09-01T00:00:00.000Z"),
  ];
}

/** 公開 API の 1 経路だけを持つアプリ。 */
function appWith(scope: Parameters<typeof requireScope>[0]) {
  const app = new Hono<PublicApiEnv>();
  app.use("*", apiKeyMiddleware());
  app.get("/probe", requireScope(scope), (c) => c.json({ ok: true, key: getApiKey(c).apiKeyId }));
  return app;
}

function envWith(fake: FakeD1) {
  return { ...createFakeEnv(fake), RATELIMIT: fakeKv() } as never;
}

/** 認証に必要な行を積む。①org_directory ②api_key ③lastUsedAt の UPDATE */
function primeAuth(fake: FakeD1, row: unknown[] | null): void {
  fake.enqueueRows([[TEST_ORG.organizationId]]);
  fake.enqueueRows(row === null ? [] : [row]);
}

async function call(app: Hono<PublicApiEnv>, fake: FakeD1, token: string): Promise<Response> {
  return app.fetch(
    new Request("https://pk.example/probe", { headers: { authorization: `Bearer ${token}` } }),
    envWith(fake),
  );
}

describe("apiKeyMiddleware — 通す", () => {
  it("生きているキーなら通る", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: ["tasks:read"], propertyIds: null }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    const response = await call(appWith("tasks:read"), fake, issued.token);
    expect(response.status).toBe(200);
  });

  it("`lastUsedAt` を進める（§6.1）", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: ["tasks:read"], propertyIds: null }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    await call(appWith("tasks:read"), fake, issued.token);
    expect(fake.queries.some((query) => query.sql.startsWith('update "api_key"'))).toBe(true);
  });
});

describe("apiKeyMiddleware — 401（理由を返さない）", () => {
  it("ヘッダが無ければ 401", async () => {
    const fake = createFakeD1();
    const response = await appWith("tasks:read").fetch(
      new Request("https://pk.example/probe"),
      envWith(fake),
    );
    expect(response.status).toBe(401);
  });

  it("形の違うトークンは 401", async () => {
    const fake = createFakeD1();
    const response = await call(appWith("tasks:read"), fake, "not-a-token");
    expect(response.status).toBe(401);
  });

  it("組織が引けなければ 401", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([]);
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    expect((await call(appWith("tasks:read"), fake, issued.token)).status).toBe(401);
  });

  it("キーが無ければ 401", async () => {
    const fake = createFakeD1();
    primeAuth(fake, null);
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    expect((await call(appWith("tasks:read"), fake, issued.token)).status).toBe(401);
  });

  it("失効したキーは 401", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: ["tasks:read"], propertyIds: null, revokedAt: 1 }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    expect((await call(appWith("tasks:read"), fake, issued.token)).status).toBe(401);
  });

  it("期限切れのキーは 401", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: ["tasks:read"], propertyIds: null, expiresAt: 1 }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    expect((await call(appWith("tasks:read"), fake, issued.token)).status).toBe(401);
  });

  it("**理由を本文に載せない**（生きているキーの探索を許さない）", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: ["tasks:read"], propertyIds: null, revokedAt: 1 }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    const body = await (await call(appWith("tasks:read"), fake, issued.token)).json();
    expect(body).toEqual({ error: "UNAUTHORIZED" });
  });
});

describe("requireScope — 403（§8.4）", () => {
  it("スコープが足りなければ 403", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: ["tasks:read"], propertyIds: null }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    const response = await call(appWith("invoices:read"), fake, issued.token);
    expect(response.status).toBe(403);
  });

  it("**401 と区別する**（認証は通っている）", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: ["tasks:read"], propertyIds: null }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    const body = await (await call(appWith("findings:read"), fake, issued.token)).json();
    expect(body).toMatchObject({ error: "FORBIDDEN", requiredScope: "findings:read" });
  });

  it("スコープが空のキーは何も通らない", async () => {
    const fake = createFakeD1();
    primeAuth(fake, apiKeyRow({ scopes: [], propertyIds: null }));
    const issued = await issueApiKey(TEST_ORG.orgShortId);
    expect((await call(appWith("tasks:read"), fake, issued.token)).status).toBe(403);
  });
});

describe("isPropertyAllowed — `propertyIds` 制限（§8.4）", () => {
  it("`null` は組織全体", () => {
    expect(isPropertyAllowed({ apiKeyId: API_KEY_ID, scopes: [], propertyIds: null }, PROPERTY_A)).toBe(
      true,
    );
  });

  it("載っている施設は通る", () => {
    expect(
      isPropertyAllowed({ apiKeyId: API_KEY_ID, scopes: [], propertyIds: [PROPERTY_A] }, PROPERTY_A),
    ).toBe(true);
  });

  it("載っていない施設は通らない", () => {
    expect(
      isPropertyAllowed({ apiKeyId: API_KEY_ID, scopes: [], propertyIds: [PROPERTY_A] }, PROPERTY_B),
    ).toBe(false);
  });

  it("**`[]` は 1 件も通らない**（`null` と区別する）", () => {
    expect(
      isPropertyAllowed({ apiKeyId: API_KEY_ID, scopes: [], propertyIds: [] }, PROPERTY_A),
    ).toBe(false);
  });
});

describe("レート制限（§6.5）", () => {
  it("3 つのバケットが宣言されている", () => {
    expect(RATE_LIMITS.publicApi).toEqual({ limit: 600, windowSeconds: 60 });
    expect(RATE_LIMITS.publicOccupancy).toEqual({ limit: 60, windowSeconds: 60 });
    expect(RATE_LIMITS.publicSignals).toEqual({ limit: 300, windowSeconds: 60 });
  });

  it("**識別子はトークンのハッシュ**（平文を KV のキー名にしない）", () => {
    const text = source("../../../middleware/apiKey.ts");
    expect(text).toContain('consumeRateLimit(c.env, "publicApi", keyHash, now)');
  });

  it("投入の口に上乗せが掛かっている", () => {
    const text = code("./public.ts");
    expect(text).toContain('requireEndpointRateLimit("publicOccupancy")');
    expect(text).toContain('requireEndpointRateLimit("publicSignals")');
  });
});

describe("構造の不変条件", () => {
  it("**公開 API が `assertPermission()` を呼ばない**（DECISIONS #151）", () => {
    const text = code("./public.ts");
    expect(text).not.toContain("assertPermission");
    expect(text).not.toContain("lib/auth/permission");
  });

  it("公開 API がセッションを読まない", () => {
    expect(code("./public.ts")).not.toContain("getSession");
  });

  it("**平文を再表示する口が無い**（§6.1 MUST）", () => {
    const text = code("./apiKeys.ts");
    // 平文を載せているのは作成の応答 1 か所だけ。
    expect(text.split("issued.token").length - 1).toBe(1);
    // 再発行・再取得の口が無い。
    expect(text).not.toContain("regenerate");
    expect(text).not.toContain("reveal");
  });

  it("一覧が `keyHash` を返さない", () => {
    expect(source("./apiKeys.ts")).not.toContain("keyHash: row.keyHash");
  });

  it("7 経路がすべて `requireScope()` を通る", () => {
    const text = code("./public.ts");
    // `publicApi.get(` / `publicApi.post(` の数と `requireScope(` の数が一致する。
    const routes = text.match(/publicApi\.(get|post)\(/g) ?? [];
    const scoped = text.match(/requireScope\(/g) ?? [];
    expect(routes.length).toBeGreaterThanOrEqual(7);
    expect(scoped.length).toBe(routes.length);
  });
});
