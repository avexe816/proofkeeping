/**
 * middleware の取り付け順（P0-10）。
 *
 * 順序を間違えると失敗の形が変わる。**404 のはずが 500 になる**（写像が
 * 内側にある）、**tenant が無いまま ID を照合する**（guard が前にある）。
 * どちらも壊れ方が静かなので、順序そのものをテストで固定する。
 */

import type { Env } from "@pk/db";
import { NotFoundError } from "@pk/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../lib/auth/cookie.js";
import { createSession } from "../lib/auth/session.js";
import { createFakeKv } from "../lib/auth/test-support/fake-kv.js";

import {
  apiErrorHandler,
  apiNotFoundHandler,
  getTenant,
  useTenantMiddleware,
  type AppEnv,
  type TenantDeps,
} from "./index.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-08-12T09:00:00.000Z");
const ORG_SHORT_ID = "a1b2c3";
const MEMBERSHIP_ID = `${ORG_SHORT_ID}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

const DEPS: TenantDeps = {
  findMembershipByUserId: () =>
    Promise.resolve({ id: MEMBERSHIP_ID, role: "CLEANER", isActive: true }),
  listAssignedPropertyIds: () => Promise.resolve([`${ORG_SHORT_ID}__prop_A`]),
};

function setup(): { app: Hono<AppEnv>; env: Env; cookie: () => Promise<string> } {
  const env = { SESSION: createFakeKv().namespace, SESSION_SECRET: SECRET } as unknown as Env;

  const app = new Hono<AppEnv>();
  useTenantMiddleware(app, DEPS);
  app.get("/tasks/:taskId", (c) => c.json({ role: getTenant(c).role }));
  app.get("/boom", () => {
    throw new NotFoundError();
  });

  return {
    app,
    env,
    cookie: async () => {
      const created = await createSession(env, {
        userId: `${ORG_SHORT_ID}__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
        organizationId: "org_test_alpha",
        orgShortId: ORG_SHORT_ID,
        membershipId: MEMBERSHIP_ID,
        authMethod: "PIN",
        now: NOW,
      });
      return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
    },
  };
}

describe("useTenantMiddleware", () => {
  it("セッションが無ければ 401（session が最初に効く）", async () => {
    const { app, env } = setup();

    const res = await app.request(`/tasks/${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`, {}, env);

    expect(res.status).toBe(401);
  });

  it("通ればハンドラで TenantContext を取り出せる", async () => {
    const { app, env, cookie } = setup();

    const res = await app.request(
      `/tasks/${ORG_SHORT_ID}__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH`,
      { headers: { Cookie: await cookie() } },
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "CLEANER" });
  });

  it("別組織の ID は 404（guard が tenant の後に効く）", async () => {
    const { app, env, cookie } = setup();

    const res = await app.request(
      "/tasks/z9y8x7__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      { headers: { Cookie: await cookie() } },
      env,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "RESOURCE_NOT_FOUND" });
  });

  it("ハンドラの NotFoundError も 404（写像が最外周にある）", async () => {
    const { app, env, cookie } = setup();

    const res = await app.request("/boom", { headers: { Cookie: await cookie() } }, env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "RESOURCE_NOT_FOUND" });
  });

  it("app.route() で合成しても効き続ける（index.ts と同じ形）", async () => {
    // Hono は子アプリの errorHandler を保って包み直すが、**notFoundHandler は
    // 引き継がない。** 本番の配線（apps/web/src/index.ts）はこの形なので、
    // 合成した状態で 401 / 404 の写像が生きていることをここで固定する。
    const { app: api, env, cookie } = setup();
    const root = new Hono<AppEnv>();
    root.onError(apiErrorHandler());
    root.notFound(apiNotFoundHandler());
    root.route("/api/v1", api);

    const unauthenticated = await root.request("/api/v1/boom", {}, env);
    const crossTenant = await root.request(
      "/api/v1/tasks/z9y8x7__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      { headers: { Cookie: await cookie() } },
      env,
    );
    const thrown = await root.request(
      "/api/v1/boom",
      { headers: { Cookie: await cookie() } },
      env,
    );

    expect(unauthenticated.status).toBe(401);
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.json()).toEqual({ error: "RESOURCE_NOT_FOUND" });
    expect(thrown.status).toBe(404);
  });

  it("未定義の経路も同じ 404 の本体（notFound は最上位に置く）", async () => {
    // 子アプリに notFound を登録しても合成時に落ちる。**最上位にしか置けない。**
    // ここが Hono 既定のテキスト 404 のままだと、応答の形の違いだけで
    // 「その URL は実装されている」と分かってしまう。
    const { app: api, env, cookie } = setup();
    const root = new Hono<AppEnv>();
    root.onError(apiErrorHandler());
    root.notFound(apiNotFoundHandler());
    root.route("/api/v1", api);

    const unknown = await root.request(
      "/api/v1/nothing-here",
      { headers: { Cookie: await cookie() } },
      env,
    );

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "RESOURCE_NOT_FOUND" });
  });

  it("未認証でも 403 を返さない", async () => {
    const { app, env } = setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await app.request("/boom", {}, env);

    expect(res.status).toBe(401);
    expect(res.status).not.toBe(403);
    spy.mockRestore();
  });
});
