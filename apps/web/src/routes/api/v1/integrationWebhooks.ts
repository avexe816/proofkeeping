/**
 * 汎用 Webhook 受信口（PK-SPEC-P6 §4.2 / P6-04）。
 *
 * ```
 * POST /api/v1/integrations/webhook/:integrationId
 * ```
 *
 * task:  docs/tasks/P6-04.md
 * ルール: .claude/rules/security.md §7・§8
 *
 * ── セッションを持たない経路 ────────────────────────────
 * 呼ぶのは顧客のスマートロック（またはそれを中継する顧客のシステム）で、
 * Cookie も組織も持たない。**認証 middleware の前段に置く**（`/api/v1/webhooks`
 * と同じ）。守っているのは**署名**であって、セッションではない。
 *
 * ── §4.2 MUST が要求するもの ────────────────────────────
 *   - 署名検証を必須にする。**検証失敗は 401。**
 *   - タイムスタンプが 5 分以上ずれていたら拒否（リプレイ対策）。
 *   - 同一イベントの重複受信を `(deviceId, type, occurredAt)` で排除する。
 *   - **レスポンスは 200 を即返し、処理は Queue へ。**
 * 重複排除は `insertPhysicalSignals()`（コンシューマ側）の責務で、この口は
 * 「署名を確かめて投げる」までを持つ。
 *
 * ── ここで DB を引かない ────────────────────────────────
 * `lookupOrganizationId()` を**リクエストハンドラから呼ばない**
 * （`packages/db/src/orgDirectory.ts` の注記）。組織の解決も連携の読み取りも
 * コンシューマ（`consumers/signalIngest.ts`）の仕事。
 *
 * **署名鍵は KV から直接引く。** `integration.webhookSecretRef` を読むには
 * D1 が要るが、参照キーは `integrationId` から組み立てられる
 * （`lib/integration/credentials.ts` の `credentialRefFor()`）。おかげで
 * この口は D1 を 1 度も触らずに署名を検証できる。
 *
 * ── 失敗の理由を返さない ────────────────────────────────
 * 連携が存在しないのか、鍵が未設定なのか、署名が違うのか、時刻がずれて
 * いるのかを応答で区別しない。区別すると `integrationId` の総当たりで
 * 「どの連携が実在するか」を引ける（403 を返さない理由と同じ / INV-31）。
 * **すべて 401。**
 */

import { MAX_WEBHOOK_BODY_BYTES, webhookSignalBodySchema } from "@pk/contracts";
import { Hono } from "hono";

import type { SignalIngestMessage } from "../../../consumers/signalIngest.js";
import { consumeRateLimit } from "../../../lib/auth/rateLimit.js";
import { credentialRefFor, getCredential } from "../../../lib/integration/credentials.js";
import {
  readPkWebhookHeaders,
  verifyPkWebhookSignature,
} from "../../../lib/integration/webhookSignature.js";
import type { AppEnv } from "../../../middleware/index.js";

const integrationWebhooks = new Hono<AppEnv>();

/** `integrationId` の形。**`assertIdBelongsToTenant()` と同じ厳しさで見る。** */
const INTEGRATION_ID_PATTERN = /^([0-9a-z]{6})__intg_[0-9A-HJKMNP-TV-Z]{26}$/;

integrationWebhooks.post("/webhook/:integrationId", async (c) => {
  // **`getNow(c)` を使わない。** `now` を積むのは session middleware で、
  // この経路はその前段にある。入口なのでここが時刻の起点になる。
  const now = new Date();
  const integrationId = c.req.param("integrationId");

  const matched = INTEGRATION_ID_PATTERN.exec(integrationId);
  const orgShortId = matched?.[1];
  if (orgShortId === undefined) {
    // 形が違う。**存在しない連携と区別しない。**
    return c.json({ error: "UNAUTHORIZED" as const }, 401);
  }

  // §8: Webhook 受信 1200 req/分/integration。**identifier は連携 ID。**
  // 署名を検証する前だが、`integrationId` は URL に現れる公開値で、
  // これを鍵にしても秘密は漏れない。IP で数えると、1 台の中継サーバーが
  // 全施設ぶんを送る構成で正常な受信が落ちる。
  const limited = await consumeRateLimit(c.env, "webhook", `intg:${integrationId}`, now);
  if (!limited.allowed) {
    return c.json({ error: "RATE_LIMITED" as const }, 429, {
      "Retry-After": String(limited.retryAfterSeconds),
    });
  }

  // **本文を先に文字列で読む。** 署名の対象は生のバイト列で、
  // `JSON.parse()` してから組み直すと 1 バイトの違いで検証が落ちる。
  const body = await c.req.raw.text();
  if (body.length > MAX_WEBHOOK_BODY_BYTES) {
    // 署名を計算する前に切る。**巨大な本文で CPU 予算を焼かせない。**
    return c.json({ error: "PAYLOAD_TOO_LARGE" as const }, 413);
  }

  // 署名鍵を KV から。**D1 を引かない**（上の注記）。
  let secret = "";
  try {
    const credential = await getCredential(
      c.env,
      { orgShortId },
      credentialRefFor({ orgShortId }, integrationId, "WEBHOOK"),
    );
    secret = credential?.["secret"] ?? "";
  } catch {
    // 参照キーの形が違う経路。**鍵が無いのと同じ扱い。**
    secret = "";
  }

  const verification = await verifyPkWebhookSignature({
    secret,
    headers: readPkWebhookHeaders(c.req.raw),
    body,
    now,
  });
  if (!verification.ok) {
    // **理由を返さない。** 401 で一律。ログには残す（`integrationId` は
    // 組織短縮 ID を含むが、シャード番号ではない / architecture.md §1）。
    console.error(`integration-webhook-rejected reason=${verification.reason}`);
    return c.json({ error: "UNAUTHORIZED" as const }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 署名は通ったが JSON ではない。**再送しても直らない**ので 400。
    return c.json({ error: "INVALID_BODY" as const }, 400);
  }

  const envelope = webhookSignalBodySchema.safeParse(parsed);
  if (!envelope.success) {
    // 外枠だけを見る。**1 件ずつの検証はコンシューマ**（未知の種類が
    // 1 件混ざっただけで受信全体を落とさない / `contracts/integration.ts`）。
    return c.json({ error: "INVALID_BODY" as const }, 400);
  }

  const message: SignalIngestMessage = {
    kind: "SIGNAL_INGEST",
    orgShortId,
    integrationId,
    events: envelope.data.events,
    receivedAtMs: now.getTime(),
  };

  try {
    await c.env.QUEUE_RECONCILIATION.send(message);
  } catch {
    // **投入に失敗したら 500。** 送り側は再送してくれる。
    // ここで 200 を返すとイベントが失われる。
    console.error("integration-webhook-enqueue-failed");
    return c.json({ error: "QUEUE_UNAVAILABLE" as const }, 500);
  }

  // §4.2 MUST: 200 を即返す。**件数を返さない**（まだ決まっていない）。
  return c.json({ received: true });
});

export default integrationWebhooks;
