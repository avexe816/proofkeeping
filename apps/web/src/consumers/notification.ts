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

import {
  findInvoiceById,
  markInvoiceSent,
  recordDocumentDelivery,
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
  input: { to: string; cc: string[]; subject: string; body: string },
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

  const sent = await sendViaResend(env, {
    to: message.toEmail,
    cc: message.ccEmails,
    subject,
    body,
  });

  const { deliveryId } = await recordDocumentDelivery(env, ctx, {
    docType: "INVOICE",
    documentId: message.invoiceId,
    channel: "EMAIL",
    toEmail: message.toEmail,
    ccEmails: message.ccEmails,
    subject,
    // **本文の冒頭だけ。** 差異の詳細を入れない（ui-writing.md §6）。
    bodyPreview: body.slice(0, 120),
    status: sent.ok ? "SENT" : "FAILED",
    providerMessageId: sent.ok ? sent.messageId : null,
    errorMessage: sent.ok ? null : sent.reason,
    sentById: message.sentById,
    sentAt: sent.ok ? ctx.now : null,
  });

  if (!sent.ok) return { kind: "FAILED", reason: sent.reason };

  // ⑫ `CONFIRMED` のときだけ `SENT` へ。**2 回目は 0 行**（冪等）。
  await markInvoiceSent(env, ctx, message.invoiceId, ctx.now);

  return { kind: "OK", deliveryId };
}

/** `pk-notification` キューの入口。 */
export async function handleNotificationBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
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
