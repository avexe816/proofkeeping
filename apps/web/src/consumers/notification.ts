/**
 * 帳票の送付（PK-SPEC-P5 §4.1 の ⑩〜⑫ / §2.7）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P5-07.md
 * ルール: .claude/rules/billing.md §2（電帳法）/ ui-writing.md §6（通知）
 *
 * ```
 * 発行（§4.1 の ⑦ で PDF）→ PDF が R2 に載る → QUEUE_NOTIFICATION
 *                                             ← ここで Resend が送る
 * ```
 *
 * ── PDF ができてから投げる ──────────────────────────────
 * 投入するのは `consumers/invoicePdf.ts`（PDF を R2 へ置いた直後）。
 * 発行 API から直接ここへ投げない。**添付の無いメールを先に送らない**
 * ため。PDF が失敗すれば送付も起きず、`regenerate-pdf` からやり直せる。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても**送信は 1 回だけ。** 効いているのは
 * `markInvoiceSent()` の楽観ロックで、`CONFIRMED` のときしか `SENT` へ
 * 進めない。2 回目は 0 行更新になり、そこで止まる。
 * **送付ログは送信を試みるたびに 1 行増える**（§2.7 は追記のみ。
 * 誰にいつ送ったかは電子取引の記録そのもの / billing.md §2）。
 *
 * ── 本文に差異の詳細を入れない（ui-writing.md §6）───────
 * 件名と 1 行要約とリンクだけ。金額の内訳・客室の状況を本文へ書かない。
 * `bodyPreview` に残るのも同じ範囲。
 */

import { parseDeliveryEvent } from "../lib/billing/webhookEvent.js";

import { isNotifyMessage, runNotify } from "./notify.js";
import {
  handleOutboundWebhookBatch,
  isOutboundWebhookMessage,
} from "./outboundWebhook.js";
import {
  findInvoiceById,
  findReceiptById,
  lookupOrganizationId,
  markInvoiceSent,
  markReceiptSent,
  recordDocumentDelivery,
  setDeliveryProviderMessageId,
  updateDocumentDeliveryStatus,
  type Env,
  type TenantContext,
} from "@pk/db";

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface InvoiceDeliveryMessage {
  kind: "INVOICE_DELIVERY";
  organizationId: string;
  orgShortId: string;
  invoiceId: string;
  toEmail: string;
  ccEmails: string[];
  /** 送付を起こした `membership.id`。**バッチ由来なら発行者の ID。** */
  sentById: string;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない。** */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isInvoiceDeliveryMessage(value: unknown): value is InvoiceDeliveryMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "INVOICE_DELIVERY" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["invoiceId"] === "string" &&
    typeof message["toEmail"] === "string" &&
    Array.isArray(message["ccEmails"]) &&
    typeof message["sentById"] === "string" &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type InvoiceDeliveryOutcome =
  | { kind: "OK"; deliveryId: string }
  /** 請求書が無い・取り消し済み。**再送しても直らない。** */
  | { kind: "SKIPPED"; reason: string }
  /** Resend / D1 の失敗。**直しうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/** 件名（§4.1 の確認ダイアログと同じ語彙）。**金額を件名に出さない。** */
export function invoiceSubject(documentNo: string): string {
  return `請求書のご送付（${documentNo}）`;
}

/**
 * 本文。**1 行要約とリンクだけ**（ui-writing.md §6）。
 *
 * 金額の内訳・客室の状況・差異の詳細を書かない。PDF に載っている。
 */
export function invoiceBody(input: { documentNo: string; periodFrom: string; periodTo: string }): string {
  return [
    "いつもお世話になっております。",
    `${input.periodFrom} 〜 ${input.periodTo} 分の請求書（${input.documentNo}）をお送りします。`,
    "詳細は添付の PDF をご確認ください。",
  ].join("\n");
}

/** 送付ログの ID を載せるタグ名。**webhook がこれを見て行を引く。** */
export const PK_DELIVERY_TAG = "pk_delivery_id";

/** 同じものをヘッダにも載せる。 */
export const PK_DELIVERY_HEADER = "X-PK-Delivery-Id";

/** Resend の応答のうち使う部分。 */
interface ResendResponse {
  id?: string;
}

/**
 * Resend でメールを送る。
 *
 * **添付は送らない。** PDF は R2 にあり、署名付き URL で配るのが
 * `files.ts` の作りなので、リンクを本文に含めるのは P5-10 以降の
 * 送付経路（`DOWNLOAD_LINK`）で扱う。ここでは本文のみを送り、
 * **送った事実を記録すること**を優先する（§2.7）。
 */
async function sendViaResend(
  env: Env,
  input: { to: string; cc: string[]; subject: string; body: string; deliveryId: string },
): Promise<{ ok: true; messageId: string | null } | { ok: false; reason: string }> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_ADDRESS,
        to: [input.to],
        cc: input.cc,
        subject: input.subject,
        text: input.body,
        // **送付ログの ID を持たせる**（P5-10 / `lib/billing/webhookEvent.ts`）。
        // webhook は組織を知らない。ID は自己記述（`{orgShortId}__dlv_{ulid}`）
        // なので、これが返ってくればシャードを引ける。
        // タグとヘッダの両方に入れるのは、Resend の webhook が
        // どちらを載せるかが payload の種類で違うため（OPEN_QUESTIONS #077）。
        tags: [{ name: PK_DELIVERY_TAG, value: input.deliveryId }],
        headers: { [PK_DELIVERY_HEADER]: input.deliveryId },
      }),
    });

    if (!response.ok) return { ok: false, reason: `HTTP_${String(response.status)}` };

    const body = await response.json<ResendResponse>();
    return { ok: true, messageId: body.id ?? null };
  } catch (error) {
    // **中身をログへ流さない。** 例外の名前だけ（architecture.md §1）。
    return { ok: false, reason: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

/**
 * 請求書を 1 通送る（§4.1 の ⑩〜⑫）。
 *
 * **送付ログは成功でも失敗でも残す**（§2.7 / 冒頭の「冪等」）。
 */
export async function deliverInvoice(
  env: Env,
  message: InvoiceDeliveryMessage,
): Promise<InvoiceDeliveryOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    // バッチと同じ扱い（`consumers/dailyReport.ts` の注記 / OPEN_QUESTIONS #033）。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  const invoice = await findInvoiceById(env, ctx, message.invoiceId);
  if (invoice === undefined) return { kind: "SKIPPED", reason: "INVOICE_NOT_FOUND" };
  // **取り消した請求書を送らない**（§5 で赤伝が出ている）。
  if (invoice.status === "VOIDED") return { kind: "SKIPPED", reason: "INVOICE_VOIDED" };

  const subject = invoiceSubject(invoice.documentNo);
  const body = invoiceBody({
    documentNo: invoice.documentNo,
    periodFrom: invoice.periodFrom,
    periodTo: invoice.periodTo,
  });

  // **先に送付ログを起こしてから送る。** ID を Resend へ渡す必要があり、
  // 送ってから採番すると webhook が先に届いたときに引けない。
  const { deliveryId } = await recordDocumentDelivery(env, ctx, {
    docType: "INVOICE",
    documentId: message.invoiceId,
    channel: "EMAIL",
    toEmail: message.toEmail,
    ccEmails: message.ccEmails,
    subject,
    // **本文の冒頭だけ。** 差異の詳細を入れない（ui-writing.md §6）。
    bodyPreview: body.slice(0, 120),
    status: "QUEUED",
    providerMessageId: null,
    errorMessage: null,
    sentById: message.sentById,
    sentAt: null,
  });

  const sent = await sendViaResend(env, {
    to: message.toEmail,
    cc: message.ccEmails,
    subject,
    body,
    deliveryId,
  });

  await updateDocumentDeliveryStatus(env, ctx, deliveryId, {
    status: sent.ok ? "SENT" : "FAILED",
    ...(sent.ok ? {} : { errorMessage: sent.reason }),
  });
  if (sent.ok && sent.messageId !== null) {
    await setDeliveryProviderMessageId(env, ctx, deliveryId, sent.messageId);
  }

  if (!sent.ok) return { kind: "FAILED", reason: sent.reason };

  // ⑫ `CONFIRMED` のときだけ `SENT` へ。**2 回目は 0 行**（冪等）。
  await markInvoiceSent(env, ctx, message.invoiceId, ctx.now);

  return { kind: "OK", deliveryId };
}

/** `pk-notification` キューの入口。 */
export async function handleNotificationBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    // 業務通知（P6-09 / PK-SPEC-P6 §5）。**帳票の送付とは別物。**
    // あちらは電帳法の記録（billing.md §2）、こちらは補助機能（§1.3）。
    // 送信 Webhook（P6-13 / PK-SPEC-P6 §6.4）。**同じ `pk-notification`。**
    // リトライの刻みが違う（1 分〜6 時間）ので、バッチの扱いは
    // `handleOutboundWebhookBatch()` に寄せてある。
    if (isOutboundWebhookMessage(message.body)) {
      await handleOutboundWebhookBatch(env, { ...batch, messages: [message] });
      continue;
    }
    if (isNotifyMessage(message.body)) {
      const notifyOutcome = await runNotify(env, message.body);
      if (notifyOutcome.kind === "FAILED") message.retry();
      else message.ack();
      continue;
    }
    // 送付イベント（P5-10 / §2.7）。**同じ notification キュー。**
    if (isDeliveryEventMessage(message.body)) {
      const eventOutcome = await handleDeliveryEvent(env, message.body);
      if (eventOutcome.kind === "FAILED") message.retry();
      else message.ack();
      continue;
    }
    if (isReceiptDeliveryMessage(message.body)) {
      const receiptOutcome = await deliverReceipt(env, message.body);
      if (receiptOutcome.kind === "FAILED") message.retry();
      else message.ack();
      continue;
    }
    if (!isInvoiceDeliveryMessage(message.body)) {
      // 形が違うものは**再送しても直らない。** ack して落とす。
      console.error("notification-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await deliverInvoice(env, message.body);
    if (outcome.kind === "FAILED") message.retry();
    else message.ack();
  }
}


// ────────────────────────────────────────────────────────────
// 領収書の送付（P5-08 / PK-SPEC-P5 §4.2 の ⑤）
// ────────────────────────────────────────────────────────────

/** キューへ載せるメッセージ。**請求書と同じ `pk-notification`。** */
export interface ReceiptDeliveryMessage {
  kind: "RECEIPT_DELIVERY";
  organizationId: string;
  orgShortId: string;
  receiptId: string;
  toEmail: string;
  ccEmails: string[];
  sentById: string;
  requestedAtMs: number;
}

/** メッセージの形を確かめる。 */
export function isReceiptDeliveryMessage(value: unknown): value is ReceiptDeliveryMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "RECEIPT_DELIVERY" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["receiptId"] === "string" &&
    typeof message["toEmail"] === "string" &&
    Array.isArray(message["ccEmails"]) &&
    typeof message["sentById"] === "string" &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 件名。**金額を件名に出さない**（請求書と同じ）。 */
export function receiptSubject(documentNo: string): string {
  return `領収書のご送付（${documentNo}）`;
}

/** 本文。**1 行要約だけ**（ui-writing.md §6）。 */
export function receiptBody(documentNo: string): string {
  return [
    "いつもお世話になっております。",
    `領収書（${documentNo}）をお送りします。`,
    "詳細は添付の PDF をご確認ください。",
  ].join("\n");
}

/**
 * 領収書を 1 通送る（§4.2 の ⑤）。
 *
 * **送付ログは成功でも失敗でも残す**（§2.7）。`ISSUED` のときだけ
 * `SENT` へ進む（2 回目は 0 行 / 冪等）。
 */
export async function deliverReceipt(
  env: Env,
  message: ReceiptDeliveryMessage,
): Promise<InvoiceDeliveryOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  const receipt = await findReceiptById(env, ctx, message.receiptId);
  if (receipt === undefined) return { kind: "SKIPPED", reason: "RECEIPT_NOT_FOUND" };
  if (receipt.status === "VOIDED") return { kind: "SKIPPED", reason: "RECEIPT_VOIDED" };

  const subject = receiptSubject(receipt.documentNo);
  const body = receiptBody(receipt.documentNo);

  const { deliveryId } = await recordDocumentDelivery(env, ctx, {
    docType: "RECEIPT",
    documentId: message.receiptId,
    channel: "EMAIL",
    toEmail: message.toEmail,
    ccEmails: message.ccEmails,
    subject,
    bodyPreview: body.slice(0, 120),
    status: "QUEUED",
    providerMessageId: null,
    errorMessage: null,
    sentById: message.sentById,
    sentAt: null,
  });

  const sent = await sendViaResend(env, {
    to: message.toEmail,
    cc: message.ccEmails,
    subject,
    body,
    deliveryId,
  });

  await updateDocumentDeliveryStatus(env, ctx, deliveryId, {
    status: sent.ok ? "SENT" : "FAILED",
    ...(sent.ok ? {} : { errorMessage: sent.reason }),
  });
  if (sent.ok && sent.messageId !== null) {
    await setDeliveryProviderMessageId(env, ctx, deliveryId, sent.messageId);
  }

  if (!sent.ok) return { kind: "FAILED", reason: sent.reason };

  await markReceiptSent(env, ctx, message.receiptId, ctx.now);

  return { kind: "OK", deliveryId };
}


// ────────────────────────────────────────────────────────────
// 送付イベント（P5-10 / PK-SPEC-P5 §2.7）
// ────────────────────────────────────────────────────────────

/**
 * webhook が受けた 1 件。**署名の検証は受信側で済んでいる。**
 *
 * 生の payload をそのまま運ぶ。読み取り（どのイベントか・どの送付ログか）
 * は**このコンシューマの中**で行う。受信側は 200 を即返すのが仕事
 * （security.md §7）。
 */
export interface DeliveryEventMessage {
  kind: "DELIVERY_EVENT";
  /** Resend の payload。**形は信用しない**（`parseDeliveryEvent()` が絞る）。 */
  payload: unknown;
  receivedAtMs: number;
}

/** メッセージの形を確かめる。 */
export function isDeliveryEventMessage(value: unknown): value is DeliveryEventMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "DELIVERY_EVENT" &&
    "payload" in message &&
    typeof message["receivedAtMs"] === "number"
  );
}

/**
 * 送付イベントを 1 件処理する（§2.7）。
 *
 * ── 組織はここで引く ────────────────────────────────────
 * `lookupOrganizationId()` は**リクエストハンドラから呼ばない**
 * （`orgDirectory.ts` の注記）。コンシューマはセッションを持たない
 * バッチ経路なので、ここが正しい置き場所。受信の口（`webhooks.ts`）は
 * 署名を確かめて投げるだけ。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じイベントを 3 回処理しても結果が変わらない。`updateDocumentDelivery
 * Status()` が**終端（`BOUNCED` / `FAILED`）から動かない**ので、
 * 順序が入れ替わって届いても不達が配達済みに戻らない。
 */
export async function handleDeliveryEvent(
  env: Env,
  message: DeliveryEventMessage,
): Promise<InvoiceDeliveryOutcome> {
  const event = parseDeliveryEvent(message.payload, {
    tag: PK_DELIVERY_TAG,
    header: PK_DELIVERY_HEADER,
  });
  // 読めないイベント（知らない種別・送付ログの ID が無い）は
  // **再送しても直らない。**
  if (event === null) return { kind: "SKIPPED", reason: "UNREADABLE_EVENT" };

  const orgShortId = event.deliveryId.split("__")[0] ?? "";
  const organizationId = await lookupOrganizationId(env, orgShortId);
  if (organizationId === null) return { kind: "SKIPPED", reason: "ORGANIZATION_NOT_FOUND" };

  const now = new Date(message.receivedAtMs);
  const ctx: TenantContext = {
    organizationId,
    orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now,
  };

  // 開封は状態を進めず `openedAt` だけを立てる（§2.7）。
  if (event.type === "email.opened") {
    await updateDocumentDeliveryStatus(env, ctx, event.deliveryId, {
      status: "DELIVERED",
      openedAt: now,
    });
    return { kind: "OK", deliveryId: event.deliveryId };
  }

  await updateDocumentDeliveryStatus(env, ctx, event.deliveryId, {
    status: event.status,
    ...(event.status === "DELIVERED" ? { deliveredAt: now } : {}),
    ...(event.errorMessage === null ? {} : { errorMessage: event.errorMessage }),
  });

  return { kind: "OK", deliveryId: event.deliveryId };
}
