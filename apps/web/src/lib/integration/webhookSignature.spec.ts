/**
 * 汎用 Webhook 受信口の署名検証（P6-04 / PK-SPEC-P6 §4.2）。
 *
 * ルール: .claude/rules/security.md §7
 * 仕様の受け入れ基準: §8.2「Webhook の署名検証が機能する」
 *                     「5 分以上古いタイムスタンプを拒否する」
 *
 * ── 見ているもの ────────────────────────────────────────
 *   正しい署名を通す
 *   **鍵が未設定なら検証を素通りさせない**（誰でも叩ける状態を作らない）
 *   タイムスタンプが 5 分以上ずれていたら拒否（**未来方向も**）
 *   署名が 1 文字違えば拒否
 *   本文が 1 バイト違えば拒否
 *   `sha256=` を書かない署名を通さない
 */

import { describe, expect, it } from "vitest";

import {
  PK_WEBHOOK_TOLERANCE_SECONDS,
  verifyPkWebhookSignature,
  type PkWebhookHeaders,
} from "./webhookSignature.js";

const SECRET = "test-shared-secret-for-pk-webhook";
const NOW = new Date("2026-09-10T02:00:00.000Z");

/** テスト用に本物と同じ手順で署名する。 */
async function sign(timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
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
  return `sha256=${hex}`;
}

async function headersFor(body: string, at: Date = NOW): Promise<PkWebhookHeaders> {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  return { timestamp, signature: await sign(timestamp, body) };
}

const BODY = JSON.stringify({
  events: [{ deviceId: "LOCK-302", type: "DOOR_UNLOCK", occurredAt: "2026-09-09T22:14:33+09:00" }],
});

describe("verifyPkWebhookSignature（PK-SPEC-P6 §4.2 MUST）", () => {
  it("正しい署名を通す", async () => {
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: await headersFor(BODY),
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("**鍵が未設定なら通さない**（検証を素通りさせない）", async () => {
    // 連携を作っただけで鍵を入れていない状態が、
    // 「誰でも投げられる受信口」として現れないこと。
    const result = await verifyPkWebhookSignature({
      secret: "",
      headers: await headersFor(BODY),
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "NO_SECRET" });
  });

  it("ヘッダが欠けていたら通さない", async () => {
    const full = await headersFor(BODY);
    for (const headers of [
      { ...full, signature: undefined },
      { ...full, timestamp: undefined },
    ]) {
      const result = await verifyPkWebhookSignature({
        secret: SECRET,
        headers,
        body: BODY,
        now: NOW,
      });
      expect(result).toEqual({ ok: false, reason: "MISSING_HEADERS" });
    }
  });

  it("5 分ちょうどは通す（境界）", async () => {
    const sentAt = new Date(NOW.getTime() - PK_WEBHOOK_TOLERANCE_SECONDS * 1000);
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: await headersFor(BODY, sentAt),
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("5 分を 1 秒でも超えたら拒否（リプレイ対策）", async () => {
    const sentAt = new Date(NOW.getTime() - (PK_WEBHOOK_TOLERANCE_SECONDS + 1) * 1000);
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: await headersFor(BODY, sentAt),
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("**未来方向のずれも拒否する**（署名を貯めておく攻撃）", async () => {
    const sentAt = new Date(NOW.getTime() + (PK_WEBHOOK_TOLERANCE_SECONDS + 1) * 1000);
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: await headersFor(BODY, sentAt),
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("数字以外のタイムスタンプを通さない", async () => {
    for (const timestamp of [" 1757462400", "-1757462400", "1757462400.0", "abc", ""]) {
      const result = await verifyPkWebhookSignature({
        secret: SECRET,
        headers: { timestamp, signature: "sha256=00" },
        body: BODY,
        now: NOW,
      });
      expect(result, timestamp).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
    }
  });

  it("署名が 1 文字違えば拒否", async () => {
    const headers = await headersFor(BODY);
    const signature = headers.signature ?? "";
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: { ...headers, signature: flipped },
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("本文が 1 バイト違えば拒否（署名の対象は生の本文）", async () => {
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: await headersFor(BODY),
      body: `${BODY} `,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("鍵が違えば拒否", async () => {
    const result = await verifyPkWebhookSignature({
      secret: `${SECRET}x`,
      headers: await headersFor(BODY),
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("**`sha256=` の無い素の 16 進を通さない**（方式を書かせる）", async () => {
    const headers = await headersFor(BODY);
    const bare = (headers.signature ?? "").slice("sha256=".length);
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: { ...headers, signature: bare },
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("大文字の 16 進も通す（顧客の実装差）", async () => {
    const headers = await headersFor(BODY);
    const upper = (headers.signature ?? "").toUpperCase().replace("SHA256=", "sha256=");
    const result = await verifyPkWebhookSignature({
      secret: SECRET,
      headers: { ...headers, signature: upper },
      body: BODY,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });
});
