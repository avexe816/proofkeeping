/**
 * 送信 Webhook の配信（PK-SPEC-P6 §6.4 / P6-13）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P6-13.md
 * ルール: .claude/rules/security.md §7 / .claude/rules/ui-writing.md §6
 *
 * ```
 * 業務イベント（請求書の発行・差異の作成・…）
 *   → emitOutboundEvent()（呼び出し側は投げるだけ。失敗を握りつぶす）
 *     → QUEUE_NOTIFICATION（kind: "OUTBOUND_WEBHOOK"）
 *       → ここ: 宛先ごとに署名して POST → 失敗を数える → 5 回で無効化
 * ```
 *
 * ── 受信口と同じ署名方式にする ──────────────────────────
 * `X-PK-Signature: sha256=<hex>` と `X-PK-Timestamp`（§4.2）。
 * **顧客が受け取る側を書くとき、こちらが送る形と ProofKeeping が
 * 受ける形が同じなら、実装を 1 つ書けば済む。** 方式を分けない。
 *
 * ── 本文に詳細を入れない（ui-writing.md §6）──────────────
 * 載せるのは**イベント名・発生時刻・対象の ID** まで。差異の内容・金額・
 * 客室の状況・個人名を入れない。受け取った側は ID で公開 API を引く
 * （§6.3）。そちらはスコープで守られている。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * **同じイベントを 3 回配信しても、受け取る側が区別できる。**
 * `eventId` を本文とヘッダに載せ、再送でも変わらないようにしてある。
 * こちら側で重複を止めない：相手のサーバーが 200 を返さなかった以上、
 * 届いていない可能性の方が高い。**止めるのは受け取る側の責務**で、
 * そのために `eventId` を渡している。
 */

import {
  deactivateOutboundWebhook,
  listActiveOutboundWebhooks,
  lookupOrganizationId,
  markOutboundDelivered,
  markOutboundFailed,
  type Env,
  type OutboundWebhookEvent,
  type TenantContext,
} from "@pk/db";
import {
  isDeliverySuccess,
  outboundRetryDelaySeconds,
  shouldDisableOutbound,
  subscribesTo,
} from "@pk/integrations";

import { credentialRefFor, getCredential } from "../lib/integration/credentials.js";
import {
  PK_SIGNATURE_HEADER,
  PK_TIMESTAMP_HEADER,
} from "../lib/integration/webhookSignature.js";

import { notify } from "./notify.js";

/** キューへ載せるメッセージ。 */
export interface OutboundWebhookMessage {
  kind: "OUTBOUND_WEBHOOK";
  orgShortId: string;
  event: OutboundWebhookEvent;
  /** 対象の ID（`taskId` / `findingId` / `invoiceId` など）。 */
  targetId: string;
  /** 施設 ID。組織全体のイベントなら `null`。 */
  propertyId: string | null;
  /**
   * 配信 1 件を識別する値。**再送でも変わらない。**
   * 受け取る側の重複排除に使ってもらう（冒頭の注記）。
   */
  eventId: string;
  /** 発生時刻（ミリ秒）。**再送でも変わらない。** */
  occurredAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isOutboundWebhookMessage(value: unknown): value is OutboundWebhookMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "OUTBOUND_WEBHOOK" &&
    typeof message["orgShortId"] === "string" &&
    message["orgShortId"].length > 0 &&
    typeof message["event"] === "string" &&
    typeof message["targetId"] === "string" &&
    (message["propertyId"] === null || typeof message["propertyId"] === "string") &&
    typeof message["eventId"] === "string" &&
    message["eventId"].length > 0 &&
    typeof message["occurredAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type OutboundWebhookOutcome =
  | {
      kind: "OK";
      delivered: number;
      /** 失敗した宛先の数。**1 件でもあれば retry。** */
      failed: number;
      /** この回で無効化した宛先の数（§6.4 MUST）。 */
      disabled: number;
    }
  /** 再送しても直らない。**ack して落とす。** */
  | { kind: "DROPPED"; reason: string };

/** 相手を待つ上限（ミリ秒）。**リクエストハンドラではないが無限に待たない。** */
export const OUTBOUND_TIMEOUT_MS = 10_000;

/**
 * 1 メッセージぶんを配信する。
 *
 * **宛先が 0 件でも成功。** 送信 Webhook を使っていない組織が普通。
 */
export async function runOutboundWebhook(
  env: Env,
  message: OutboundWebhookMessage,
): Promise<OutboundWebhookOutcome> {
  const organizationId = await lookupOrganizationId(env, message.orgShortId);
  if (organizationId === null) return { kind: "DROPPED", reason: "ORGANIZATION_NOT_FOUND" };

  const ctx: TenantContext = {
    organizationId,
    orgShortId: message.orgShortId,
    // バッチはセッションを持たない。**組織全体ロールで動く。**
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.occurredAtMs),
  };

  let targets;
  try {
    targets = await listActiveOutboundWebhooks(env, ctx);
  } catch {
    // D1 が落ちている。**retry へ倒す**ため失敗として返す。
    return { kind: "OK", delivered: 0, failed: 1, disabled: 0 };
  }

  const subscribed = targets.filter((row) => subscribesTo(row.events, message.event));
  if (subscribed.length === 0) return { kind: "OK", delivered: 0, failed: 0, disabled: 0 };

  const body = JSON.stringify(outboundPayload(message));

  let delivered = 0;
  let failed = 0;
  let disabled = 0;
  for (const target of subscribed) {
    const ok = await deliverTo(env, ctx, target, body, message.occurredAtMs);
    if (ok) {
      await markOutboundDelivered(env, ctx, target.id);
      delivered += 1;
      continue;
    }

    await markOutboundFailed(env, ctx, target.id);
    failed += 1;
    // **`markOutboundFailed()` の直後に数え直す。** あの関数は SQL で
    // 1 増やすので、増えた後の値は手元の行からは分からない。
    // ここでは読み直さず、読んだ時点の値 +1 で判断する（同じ配信で
    // 2 回数えることは無いので一致する）。
    if (shouldDisableOutbound(target.failureCount + 1)) {
      await deactivateOutboundWebhook(env, ctx, target.id);
      disabled += 1;
      // §6.4 MUST「5 回失敗で無効化し、**管理者に通知する**」。
      // §5.1 に送信 Webhook 専用のイベントが無いので `integration.error`
      // を使う（docs/OPEN_QUESTIONS.md #093）。
      await notify(env, {
        orgShortId: ctx.orgShortId,
        eventCode: "integration.error",
        propertyId: null,
        subject: "送信 Webhook を停止しました",
        summary: "通知先へ続けて送れなかったため、この送信先への配信を止めました。",
        linkPath: "/app/settings/integrations",
        dedupeKey: `outbound.disabled:${target.id}`,
        requestedAtMs: message.occurredAtMs,
      });
    }
  }

  return { kind: "OK", delivered, failed, disabled };
}

/**
 * 配信する本文（§6.4）。
 *
 * **ID までしか載せない**（冒頭の注記）。受け取った側は公開 API で引く。
 */
export function outboundPayload(message: OutboundWebhookMessage): Record<string, unknown> {
  return {
    eventId: message.eventId,
    event: message.event,
    occurredAt: new Date(message.occurredAtMs).toISOString(),
    targetId: message.targetId,
    propertyId: message.propertyId,
  };
}

/** 署名を作る。**受信口（§4.2）が検証するのと同じ形。** */
export async function signOutboundBody(
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
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
    new TextEncoder().encode(`${String(timestampSeconds)}.${body}`),
  );
  const hex = [...new Uint8Array(signed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

/** 1 宛先へ送る。**例外を投げない**（1 件の失敗で他を巻き込まない）。 */
async function deliverTo(
  env: Env,
  ctx: TenantContext,
  target: { id: string; url: string; secretRef: string },
  body: string,
  occurredAtMs: number,
): Promise<boolean> {
  let secret = "";
  try {
    const credential = await getCredential(
      env,
      { orgShortId: ctx.orgShortId },
      credentialRefFor({ orgShortId: ctx.orgShortId }, target.id, "WEBHOOK"),
    );
    secret = credential?.["secret"] ?? "";
  } catch {
    secret = "";
  }
  if (secret === "") {
    // 署名鍵が無い。**署名なしで送らない**（受け取る側が検証できない）。
    console.error("outbound-webhook-secret-missing");
    return false;
  }

  // **送信時刻ではなく発生時刻を署名に含める。** 再送で署名が変わると、
  // 受け取る側が「同じイベントの再送」と判断できなくなる。
  const timestampSeconds = Math.floor(occurredAtMs / 1000);
  const signature = await signOutboundBody(secret, timestampSeconds, body);

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PK_SIGNATURE_HEADER]: signature,
        [PK_TIMESTAMP_HEADER]: String(timestampSeconds),
      },
      body,
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    return isDeliverySuccess(response.status);
  } catch {
    // **応答の中身をログへ流さない**（宛先は顧客のシステム）。
    console.error("outbound-webhook-delivery-failed");
    return false;
  }
}

/**
 * バッチを処理する。
 *
 * リトライは 1 分 → 5 分 → 30 分 → 2 時間 → 6 時間、**最大 5 回**（§6.4）。
 * 6 回目は ack して落とす。そこまでに宛先は無効化されている
 * （5 回失敗で `isActive = false`）ので、抱え続ける意味が無い。
 */
export async function handleOutboundWebhookBatch(
  env: Env,
  batch: MessageBatch,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isOutboundWebhookMessage(message.body)) {
      console.error("outbound-webhook-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await runOutboundWebhook(env, message.body);
    if (outcome.kind === "DROPPED") {
      console.error(`outbound-webhook-dropped reason=${outcome.reason}`);
      message.ack();
      continue;
    }
    if (outcome.failed === 0) {
      message.ack();
      continue;
    }
    const delaySeconds = outboundRetryDelaySeconds(message.attempts);
    if (delaySeconds === null) {
      console.error("outbound-webhook-retries-exhausted");
      message.ack();
    } else {
      message.retry({ delaySeconds });
    }
  }
}

/**
 * イベントを投げる（呼び出し側の入口）。
 *
 * **失敗を握りつぶす。** 送信 Webhook は顧客の都合で足す通知経路で、
 * 投入に失敗しても業務の処理を止めない（`notify()` と同じ方針）。
 */
export async function emitOutboundEvent(
  env: Env,
  message: Omit<OutboundWebhookMessage, "kind">,
): Promise<void> {
  try {
    await env.QUEUE_NOTIFICATION.send({
      kind: "OUTBOUND_WEBHOOK",
      ...message,
    } satisfies OutboundWebhookMessage);
  } catch {
    console.error(`outbound-webhook-enqueue-failed event=${message.event}`);
  }
}
