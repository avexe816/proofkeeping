/**
 * Webhook の受信（PK-SPEC-P5 §2.7 / P5-10）。
 *
 * ```
 * POST /api/v1/webhooks/resend
 * ```
 *
 * task:  docs/tasks/P5-10.md
 * ルール: .claude/rules/security.md §7・§8
 *
 * ── セッションを持たない経路 ────────────────────────────
 * 呼ぶのは Resend で、Cookie も組織も持たない。**認証 middleware の
 * 前段に置く**（`app` 側。`/api/health` や `/api/v1/auth` と同じ）。
 * 守っているのは**署名**であって、セッションではない。
 *
 * ── security.md §7 が要求するもの ───────────────────────
 *   - HMAC-SHA256 署名を必須検証。**失敗は 401。**
 *   - タイムスタンプが 5 分以上ずれていたら拒否（リプレイ対策）。
 *   - **受信は 200 を即返し、処理は Queue へ。**
 * §8 の「Webhook 受信 1200 req/分/integration」もここで掛ける。
 *
 * ── ここで DB を引かない ────────────────────────────────
 * 組織の解決（`lookupOrganizationId()`）は**リクエストハンドラから
 * 呼ばない**（`packages/db/src/orgDirectory.ts` の注記）。読み取りも
 * 更新もコンシューマ（`consumers/notification.ts`）の仕事。
 * この口は「署名を確かめて投げる」だけ。
 *
 * ── 失敗の理由を返さない ────────────────────────────────
 * 署名が違うのか、時刻がずれているのか、鍵が未設定なのかを応答で
 * 区別しない（認証の失敗応答を一律にする / security.md §2 と同じ向き）。
 */

import { Hono } from "hono";

import { clientIp, consumeRateLimit } from "../../../lib/auth/rateLimit.js";
import {
  readWebhookHeaders,
  verifyWebhookSignature,
} from "../../../lib/billing/webhookSignature.js";
import type { DeliveryEventMessage } from "../../../consumers/notification.js";
import type { AppEnv } from "../../../middleware/index.js";

const webhooks = new Hono<AppEnv>();

/**
 * Resend の送付イベント（§2.7）。
 *
 * **本文を先に文字列で読む。** 署名の対象は生のバイト列で、
 * `JSON.parse()` してから組み直すと 1 バイトの違いで検証が落ちる。
 */
webhooks.post("/resend", async (c) => {
  // **`getNow(c)` を使わない。** `now` を積むのは session middleware で、
  // この経路はその前段にある（`c.get("now")` は未設定）。入口なので
  // ここが時刻の起点になる（session middleware も同じことをしている）。
  const now = new Date();

  // §8: 1200 req/分。**identifier は IP**（integration の識別子は
  // 署名を検証するまで信用できない）。
  const limited = await consumeRateLimit(c.env, "webhook", clientIp(c.req.raw), now);
  if (!limited.allowed) {
    return c.json({ error: "RATE_LIMITED" as const }, 429, {
      "Retry-After": String(limited.retryAfterSeconds),
    });
  }

  const body = await c.req.raw.text();
  const verification = await verifyWebhookSignature({
    secret: c.env.RESEND_WEBHOOK_SECRET,
    headers: readWebhookHeaders(c.req.raw),
    body,
    now,
  });

  if (!verification.ok) {
    // **理由を返さない。** 401 で一律。
    console.error(`webhook-rejected reason=${verification.reason}`);
    return c.json({ error: "UNAUTHORIZED" as const }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // 署名は通ったが JSON ではない。**再送しても直らない**ので 200。
    console.error("webhook-invalid-json");
    return c.json({ received: true });
  }

  const message: DeliveryEventMessage = {
    kind: "DELIVERY_EVENT",
    payload,
    receivedAtMs: now.getTime(),
  };

  try {
    await c.env.QUEUE_NOTIFICATION.send(message);
  } catch {
    // **投入に失敗したら 500。** Resend は再送してくれる。
    // ここで 200 を返すとイベントが失われる。
    console.error("webhook-enqueue-failed");
    return c.json({ error: "QUEUE_UNAVAILABLE" as const }, 500);
  }

  // §7: 受信は 200 を即返す。
  return c.json({ received: true });
});

export default webhooks;
