/**
 * セッション middleware（P0-10）。
 *
 * 見るのは「Cookie の有無・妥当性が応答にどう写るか」だけ。
 * KV の読み書きとレコード検証は lib/auth/session.spec.ts が持っている。
 */

import type { Env } from "@pk/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../lib/auth/cookie.js";
import { createSession } from "../lib/auth/session.js";
import { createFakeKv } from "../lib/auth/test-support/fake-kv.js";

import type { AppEnv } from "./context.js";
import { sessionMiddleware } from "./session.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const NOW = new Date("2026-08-12T09:00:00.000Z");

const SESSION_INPUT = {
  userId: "a1b2c3__usr_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  membershipId: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  authMethod: "PASSWORD",
  now: NOW,
} as const;

function setup(): { app: Hono<AppEnv>; env: Env } {
  const env = { SESSION: createFakeKv().namespace, SESSION_SECRET: SECRET } as unknown as Env;

  const app = new Hono<AppEnv>();
  app.use("*", sessionMiddleware());
  app.get("/probe", (c) =>
    c.json({
      userId: c.get("session")?.userId ?? null,
      hasNow: c.get("now") !== undefined,
    }),
  );
  return { app, env };
}

/** 有効な Cookie ヘッダを 1 本作る。 */
async function issueCookie(env: Env): Promise<string> {
  const created = await createSession(env, SESSION_INPUT);
  return `${SESSION_COOKIE_NAME}=${created.cookieValue}`;
}

describe("通過", () => {
  it("有効なセッションなら session と now を文脈に載せる", async () => {
    const { app, env } = setup();
    const cookie = await issueCookie(env);

    const res = await app.request("/probe", { headers: { Cookie: cookie } }, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: SESSION_INPUT.userId, hasNow: true });
  });

  it("他の Cookie が混ざっていても読める", async () => {
    const { app, env } = setup();
    const cookie = await issueCookie(env);

    const res = await app.request(
      "/probe",
      { headers: { Cookie: `theme=dark; ${cookie}; locale=ja` } },
      env,
    );

    expect(res.status).toBe(200);
  });
});

describe("拒否", () => {
  /** 401 になり、本体がコードだけであることを確かめる。 */
  async function expectUnauthenticated(res: Response): Promise<void> {
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
  }

  it("Cookie が無い", async () => {
    const { app, env } = setup();
    await expectUnauthenticated(await app.request("/probe", {}, env));
  });

  it("Cookie が空", async () => {
    const { app, env } = setup();
    const res = await app.request(
      "/probe",
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=` } },
      env,
    );
    await expectUnauthenticated(res);
  });

  it("署名が合わない", async () => {
    const { app, env } = setup();
    const cookie = await issueCookie(env);
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    await expectUnauthenticated(await app.request("/probe", { headers: { Cookie: tampered } }, env));
  });

  it("KV に実体が無い", async () => {
    const { app, env } = setup();
    // 署名は正しいが KV には入っていない値。
    const other = { SESSION: createFakeKv().namespace, SESSION_SECRET: SECRET } as unknown as Env;
    const cookie = await issueCookie(other);
    await expectUnauthenticated(await app.request("/probe", { headers: { Cookie: cookie } }, env));
  });

  it("理由によって応答が変わらない", async () => {
    // security.md §2 と同じ方針。どれで落ちたかを外から区別させない。
    const { app, env } = setup();
    const noCookie = await app.request("/probe", {}, env);
    const badSignature = await app.request(
      "/probe",
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=abc.def` } },
      env,
    );

    expect(noCookie.status).toBe(badSignature.status);
    expect(await noCookie.json()).toEqual(await badSignature.json());
  });

  it("拒否のときハンドラを実行しない", async () => {
    const env = { SESSION: createFakeKv().namespace, SESSION_SECRET: SECRET } as unknown as Env;
    let reached = false;
    const app = new Hono<AppEnv>();
    app.use("*", sessionMiddleware());
    app.get("/probe", (c) => {
      reached = true;
      return c.body(null, 204);
    });

    await app.request("/probe", {}, env);

    expect(reached).toBe(false);
  });

  it("Set-Cookie を返さない", async () => {
    // 署名の合わない値を投げ込むだけで Set-Cookie を引き出せてはならない。
    const { app, env } = setup();
    const res = await app.request(
      "/probe",
      { headers: { Cookie: `${SESSION_COOKIE_NAME}=abc.def` } },
      env,
    );
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });
});
