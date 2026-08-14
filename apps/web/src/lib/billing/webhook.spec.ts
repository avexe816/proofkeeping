/**
 * Webhook の署名検証とイベント読み取り（P5-10 / PK-SPEC-P5 §2.7）。
 *
 * ルール: .claude/rules/security.md §7
 *
 * ── 見ているもの ────────────────────────────────────────
 *   **鍵が未設定なら検証を素通りさせない**（誰でも叩ける状態を作らない）
 *   タイムスタンプが 5 分以上ずれていたら拒否（**未来方向も**）
 *   署名が 1 文字違えば拒否
 *   送付ログの ID をタグからもヘッダからも読めること
 *   **不達の理由に宛先・本文を入れない**
 */

import { describe, expect, it } from "vitest";

import {
  parseDeliveryEvent,
  statusOfEvent,
  RESEND_EVENT_TYPES,
} from "./webhookEvent.js";
import {
  WEBHOOK_TOLERANCE_SECONDS,
  verifyWebhookSignature,
  type WebhookHeaders,
} from "./webhookSignature.js";

const SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2stc2lnbmluZw==";
const NOW = new Date("2026-10-28T02:00:00.000Z");
const DELIVERY_ID = "a1b2c3__dlv_01JBXQ3ZK8N4P2VYR6ABCDEFGH";

/** テスト用に本物と同じ手順で署名する。 */
async function sign(input: { id: string; timestamp: string; body: string }): Promise<string> {
  const raw = SECRET.slice(6);
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const key = await crypto.subtle.importKey(
    "raw",
    bytes.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${input.id}.${input.timestamp}.${input.body}`),
  );
  let out = "";
  for (const byte of new Uint8Array(signed)) out += String.fromCharCode(byte);
  return `v1,${btoa(out)}`;
}

async function headersFor(body: string, at: Date = NOW): Promise<WebhookHeaders> {
  const id = "msg_test";
  const timestamp = String(Math.floor(at.getTime() / 1000));
  return { id, timestamp, signature: await sign({ id, timestamp, body }) };
}

describe("verifyWebhookSignature（security.md §7）", () => {
  const body = JSON.stringify({ type: "email.delivered" });

  it("正しい署名を通す", async () => {
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers: await headersFor(body),
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("**鍵が未設定なら通さない**（検証を素通りさせない）", async () => {
    const result = await verifyWebhookSignature({
      secret: "",
      headers: await headersFor(body),
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "NO_SECRET" });
  });

  it("ヘッダが欠けていれば拒否", async () => {
    const complete = await headersFor(body);
    for (const missing of ["id", "timestamp", "signature"] as const) {
      const result = await verifyWebhookSignature({
        secret: SECRET,
        headers: { ...complete, [missing]: undefined },
        body,
        now: NOW,
      });
      expect(result).toEqual({ ok: false, reason: "MISSING_HEADERS" });
    }
  });

  it("署名が 1 文字違えば拒否", async () => {
    const headers = await headersFor(body);
    const broken = `${(headers.signature ?? "").slice(0, -1)}A`;
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers: { ...headers, signature: broken },
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("本文が 1 バイト違えば拒否（差し替えを通さない）", async () => {
    const headers = await headersFor(body);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers,
      body: `${body} `,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("5 分を超えて古ければ拒否（リプレイ対策）", async () => {
    const old = new Date(NOW.getTime() - (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers: await headersFor(body, old),
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("**未来方向のずれも拒否**（時計を進めた署名を貯めさせない）", async () => {
    const future = new Date(NOW.getTime() + (WEBHOOK_TOLERANCE_SECONDS + 1) * 1000);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers: await headersFor(body, future),
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("ちょうど 5 分は通す（境界）", async () => {
    const edge = new Date(NOW.getTime() - WEBHOOK_TOLERANCE_SECONDS * 1000);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers: await headersFor(body, edge),
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("タイムスタンプが数値でなければ拒否", async () => {
    const headers = await headersFor(body);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers: { ...headers, timestamp: "not-a-number" },
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("鍵の交代期（署名が複数）でどれか 1 つ合えば通す", async () => {
    const headers = await headersFor(body);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      headers: { ...headers, signature: `v1,AAAA ${headers.signature ?? ""}` },
      body,
      now: NOW,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("parseDeliveryEvent", () => {
  const names = { tag: "pk_delivery_id", header: "X-PK-Delivery-Id" };

  it("タグから送付ログの ID を読む", () => {
    const event = parseDeliveryEvent(
      {
        type: "email.delivered",
        data: { tags: [{ name: "pk_delivery_id", value: DELIVERY_ID }] },
      },
      names,
    );
    expect(event).toMatchObject({ deliveryId: DELIVERY_ID, status: "DELIVERED" });
  });

  it("ヘッダ（オブジェクト形式）からも読む", () => {
    const event = parseDeliveryEvent(
      { type: "email.bounced", data: { headers: { "x-pk-delivery-id": DELIVERY_ID } } },
      names,
    );
    expect(event).toMatchObject({ deliveryId: DELIVERY_ID, status: "BOUNCED" });
  });

  it("ヘッダ（配列形式）からも読む", () => {
    const event = parseDeliveryEvent(
      {
        type: "email.bounced",
        data: { headers: [{ name: "X-PK-Delivery-Id", value: DELIVERY_ID }] },
      },
      names,
    );
    expect(event?.deliveryId).toBe(DELIVERY_ID);
  });

  it("不達の理由を短く載せる", () => {
    const event = parseDeliveryEvent(
      {
        type: "email.bounced",
        data: {
          tags: [{ name: "pk_delivery_id", value: DELIVERY_ID }],
          bounce: { type: "Permanent", subType: "General" },
        },
      },
      names,
    );
    expect(event?.errorMessage).toBe("Permanent/General");
  });

  it("**理由に宛先や本文を入れない**", () => {
    const event = parseDeliveryEvent(
      {
        type: "email.bounced",
        data: {
          to: ["keiri@example.co.jp"],
          subject: "請求書のご送付（INV-2026-0042）",
          tags: [{ name: "pk_delivery_id", value: DELIVERY_ID }],
          bounce: { type: "Permanent" },
        },
      },
      names,
    );
    expect(event?.errorMessage).toBe("Permanent");
    expect(JSON.stringify(event)).not.toContain("keiri@example.co.jp");
    expect(JSON.stringify(event)).not.toContain("INV-2026-0042");
  });

  it("苦情は `BOUNCED` に寄せる（§2.7 に苦情の状態が無い）", () => {
    const event = parseDeliveryEvent(
      {
        type: "email.complained",
        data: { tags: [{ name: "pk_delivery_id", value: DELIVERY_ID }] },
      },
      names,
    );
    expect(event?.status).toBe("BOUNCED");
  });

  // ── 負例。**読めないものは `null`**（呼び出し側が ack する）。 ──
  it("送付ログの ID が無ければ `null`", () => {
    expect(parseDeliveryEvent({ type: "email.delivered", data: {} }, names)).toBeNull();
  });

  it("知らないイベント種別は `null`", () => {
    expect(
      parseDeliveryEvent(
        { type: "email.scheduled", data: { tags: [{ name: "pk_delivery_id", value: DELIVERY_ID }] } },
        names,
      ),
    ).toBeNull();
  });

  it("`data` が無ければ `null`", () => {
    expect(parseDeliveryEvent({ type: "email.delivered" }, names)).toBeNull();
  });

  it("オブジェクトでなければ `null`", () => {
    expect(parseDeliveryEvent(null, names)).toBeNull();
    expect(parseDeliveryEvent("email.delivered", names)).toBeNull();
  });

  it("別のタグ名は拾わない", () => {
    expect(
      parseDeliveryEvent(
        { type: "email.delivered", data: { tags: [{ name: "other", value: DELIVERY_ID }] } },
        names,
      ),
    ).toBeNull();
  });
});

describe("statusOfEvent", () => {
  it("開封は状態を進めない", () => {
    expect(statusOfEvent("email.opened")).toBeNull();
  });

  it("すべての種別で例外を投げない（表に穴が無い）", () => {
    for (const type of RESEND_EVENT_TYPES) {
      expect(() => statusOfEvent(type)).not.toThrow();
    }
  });
});
