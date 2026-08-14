/**
 * 汎用 Webhook 受信口の配線（P6-04 / PK-SPEC-P6 §4.2）。
 *
 * ルール: .claude/rules/security.md §7・§8
 * 仕様の受け入れ基準: §8.2「Webhook の署名検証が機能する」
 *                     「200 を即返し、処理が非同期になっている」
 *                     §8.5「他組織の integrationId で Webhook を投げると 404」
 *
 * ── 見ているもの ────────────────────────────────────────
 *   正しい署名で 200 が返り、**Queue に 1 通載る**
 *   **D1 を 1 度も引かない**（署名鍵は KV から）
 *   鍵が未設定なら 401（**素通りさせない**）
 *   署名が違えば 401 / 時刻がずれていれば 401
 *   **失敗の理由を応答に出さない**（すべて `UNAUTHORIZED`）
 *   Queue が落ちたら 500（**200 を返してイベントを失わない**）
 *   レート制限が効く
 */

import type { Env } from "@pk/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createFakeKv } from "../../../lib/auth/test-support/fake-kv.js";
import { putCredential } from "../../../lib/integration/credentials.js";
import type { AppEnv } from "../../../middleware/index.js";

import integrationWebhooks from "./integrationWebhooks.js";

const ORG_SHORT_ID = "a1b2c3";
const INTEGRATION_ID = `${ORG_SHORT_ID}__intg_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
const OTHER_INTEGRATION_ID = "z9y8x7__intg_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const SECRET = "test-shared-secret-for-pk-webhook";

/** 32 バイトの鍵（base64url）。 */
const ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

const BODY = JSON.stringify({
  events: [{ deviceId: "LOCK-302", type: "DOOR_UNLOCK", occurredAt: "2026-09-09T22:14:33+09:00" }],
});

interface Harness {
  app: Hono<AppEnv>;
  env: Env;
  sent: unknown[];
  d1Calls: number;
}

function harness(options: { queueFails?: boolean } = {}): Harness {
  const sent: unknown[] = [];
  const state = { d1Calls: 0 };
  const env = {
    CREDENTIALS: createFakeKv().namespace,
    RATELIMIT: createFakeKv().namespace,
    CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
    QUEUE_RECONCILIATION: {
      send: (message: unknown) => {
        if (options.queueFails === true) return Promise.reject(new Error("QUEUE_DOWN"));
        sent.push(message);
        return Promise.resolve();
      },
    },
    // **D1 を触ったら数える。** この経路は 1 度も引いてはならない。
    get SHARD_00() {
      state.d1Calls += 1;
      return undefined;
    },
  } as unknown as Env;

  const app = new Hono<AppEnv>();
  app.route("/api/v1/integrations", integrationWebhooks);
  return {
    app,
    env,
    sent,
    get d1Calls() {
      return state.d1Calls;
    },
  };
}

/** 鍵を KV へ入れる（本物と同じ経路）。 */
async function storeSecret(env: Env, integrationId = INTEGRATION_ID): Promise<void> {
  const orgShortId = integrationId.slice(0, 6);
  await putCredential(
    env,
    { orgShortId, now: new Date() },
    `cred:${orgShortId}:${integrationId}:WEBHOOK`,
    { secret: SECRET },
  );
}

/** テスト用に本物と同じ手順で署名する。 */
async function signedHeaders(
  body: string,
  at: Date,
  secret: string = SECRET,
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  let hex = "";
  for (const byte of new Uint8Array(signed)) hex += byte.toString(16).padStart(2, "0");
  return {
    "content-type": "application/json",
    "x-pk-timestamp": timestamp,
    "x-pk-signature": `sha256=${hex}`,
  };
}

async function post(
  h: Harness,
  headers: Record<string, string>,
  body: string,
  integrationId = INTEGRATION_ID,
): Promise<Response> {
  return h.app.request(
    `/api/v1/integrations/webhook/${integrationId}`,
    { method: "POST", headers, body },
    h.env,
  );
}

describe("POST /api/v1/integrations/webhook/:integrationId", () => {
  it("正しい署名で 200 を返し、**Queue に 1 通載る**（§4.2 MUST）", async () => {
    const h = harness();
    await storeSecret(h.env);

    const response = await post(h, await signedHeaders(BODY, new Date()), BODY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      kind: "SIGNAL_INGEST",
      orgShortId: ORG_SHORT_ID,
      integrationId: INTEGRATION_ID,
    });
  });

  it("**D1 を 1 度も引かない**（署名鍵は KV から）", async () => {
    const h = harness();
    await storeSecret(h.env);

    await post(h, await signedHeaders(BODY, new Date()), BODY);

    expect(h.d1Calls).toBe(0);
  });

  it("**鍵が未設定なら 401**（検証を素通りさせない）", async () => {
    const h = harness();
    // 鍵を入れない。
    const response = await post(h, await signedHeaders(BODY, new Date()), BODY);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(h.sent).toHaveLength(0);
  });

  it("署名が違えば 401", async () => {
    const h = harness();
    await storeSecret(h.env);

    const headers = await signedHeaders(BODY, new Date(), "wrong-secret");
    const response = await post(h, headers, BODY);

    expect(response.status).toBe(401);
    expect(h.sent).toHaveLength(0);
  });

  it("本文が差し替えられていれば 401", async () => {
    const h = harness();
    await storeSecret(h.env);

    const headers = await signedHeaders(BODY, new Date());
    const tampered = JSON.stringify({
      events: [{ deviceId: "LOCK-999", type: "DOOR_UNLOCK", occurredAt: "2026-09-09T22:14:33+09:00" }],
    });
    const response = await post(h, headers, tampered);

    expect(response.status).toBe(401);
  });

  it("5 分以上古いタイムスタンプは 401（リプレイ対策）", async () => {
    const h = harness();
    await storeSecret(h.env);

    const old = new Date(Date.now() - 6 * 60 * 1000);
    const response = await post(h, await signedHeaders(BODY, old), BODY);

    expect(response.status).toBe(401);
    expect(h.sent).toHaveLength(0);
  });

  it("署名ヘッダが無ければ 401", async () => {
    const h = harness();
    await storeSecret(h.env);

    const response = await post(h, { "content-type": "application/json" }, BODY);

    expect(response.status).toBe(401);
  });

  it("**他組織の `integrationId` は 401**（存在を示唆しない / §8.5）", async () => {
    const h = harness();
    await storeSecret(h.env);
    // 他組織の連携 ID には鍵が入っていない。**理由を区別しない。**
    const response = await post(
      h,
      await signedHeaders(BODY, new Date()),
      BODY,
      OTHER_INTEGRATION_ID,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(h.sent).toHaveLength(0);
  });

  it("形の違う `integrationId` は 401（総当たりの手掛かりを与えない）", async () => {
    const h = harness();
    const response = await post(h, await signedHeaders(BODY, new Date()), BODY, "not-an-id");

    expect(response.status).toBe(401);
  });

  it("**失敗の理由を応答に出さない**（すべて同じ本文）", async () => {
    const h = harness();
    await storeSecret(h.env);

    const noSecret = await post(
      harness(),
      await signedHeaders(BODY, new Date()),
      BODY,
    ).then((r) => r.json());
    const badSignature = await post(
      h,
      await signedHeaders(BODY, new Date(), "wrong"),
      BODY,
    ).then((r) => r.json());
    const stale = await post(
      h,
      await signedHeaders(BODY, new Date(Date.now() - 10 * 60 * 1000)),
      BODY,
    ).then((r) => r.json());

    expect(noSecret).toEqual(badSignature);
    expect(badSignature).toEqual(stale);
  });

  it("署名は通ったが JSON でなければ 400（再送しても直らない）", async () => {
    const h = harness();
    await storeSecret(h.env);

    const body = "not json";
    const response = await post(h, await signedHeaders(body, new Date()), body);

    expect(response.status).toBe(400);
    expect(h.sent).toHaveLength(0);
  });

  it("`events` が無ければ 400", async () => {
    const h = harness();
    await storeSecret(h.env);

    const body = JSON.stringify({ nope: true });
    const response = await post(h, await signedHeaders(body, new Date()), body);

    expect(response.status).toBe(400);
  });

  it("**未知の種類だけでは 400 にしない**（1 件ずつの検証はコンシューマ）", async () => {
    const h = harness();
    await storeSecret(h.env);

    const body = JSON.stringify({ events: [{ deviceId: "LOCK-302", type: "DOOR_KNOCK" }] });
    const response = await post(h, await signedHeaders(body, new Date()), body);

    expect(response.status).toBe(200);
    expect(h.sent).toHaveLength(1);
  });

  it("巨大な本文は 413（CPU 予算を焼かせない）", async () => {
    const h = harness();
    await storeSecret(h.env);

    const body = JSON.stringify({ events: [{ pad: "x".repeat(600 * 1024) }] });
    const response = await post(h, await signedHeaders(body, new Date()), body);

    expect(response.status).toBe(413);
  });

  it("**Queue が落ちたら 500**（200 を返してイベントを失わない）", async () => {
    const h = harness({ queueFails: true });
    await storeSecret(h.env);

    const response = await post(h, await signedHeaders(BODY, new Date()), BODY);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "QUEUE_UNAVAILABLE" });
  });

  it("レート制限が効く（security.md §8: 1200 req/分/integration）", async () => {
    const h = harness();
    await storeSecret(h.env);
    const headers = await signedHeaders(BODY, new Date());

    let limited: Response | undefined;
    for (let attempt = 0; attempt < 1201; attempt += 1) {
      const response = await post(h, headers, BODY);
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("Retry-After")).not.toBeNull();
  });
});
