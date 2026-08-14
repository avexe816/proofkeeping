/**
 * 帳票の送付の投入（PK-SPEC-P5 §4.1 の ⑩）。
 *
 * task:  docs/tasks/P5-07.md
 * ルール: .claude/rules/billing.md §2 / ui-writing.md §6
 *
 * ── 宛先はスナップショットから取る（billing.md §6）──────
 * `counterpartySnapshot.billingEmail` / `ccEmails`。**取引先マスタを
 * 引き直さない。** 発行後に請求先メールを変えても、その請求書は
 * 発行時の宛先へ送られる（誰宛に出した請求書かが後から変わらない）。
 * 宛先を変えたい場合は、マスタを直してから**新しい請求書を出す**か、
 * 送付経路（P5-10）が明示的に別宛先を渡す。
 */

import { findInvoiceById, type Env, type TenantContext } from "@pk/db";

import type { InvoiceDeliveryMessage } from "../../consumers/notification.js";

/** スナップショットから宛先を読む。**形が違えば `null`。** */
export function readDeliveryAddress(
  counterpartySnapshot: Record<string, unknown>,
): { toEmail: string; ccEmails: string[] } | null {
  const toEmail = counterpartySnapshot["billingEmail"];
  if (typeof toEmail !== "string" || toEmail === "") return null;

  const cc = counterpartySnapshot["ccEmails"];
  const ccEmails = Array.isArray(cc)
    ? cc.filter((value): value is string => typeof value === "string")
    : [];

  return { toEmail, ccEmails };
}

/**
 * 送付をキューへ投げる（⑩ / §9 の `resend`）。
 *
 * **投入の失敗を例外にしない。** 請求書は既に確定しており、送付は
 * やり直せる（§4.1 MUST）。呼び出し側が 503 を返すか判断する。
 *
 * @returns 投入できたか。宛先が読めないときも `false`。
 */
export async function enqueueInvoiceDelivery(
  env: Env,
  ctx: TenantContext,
  input: { invoiceId: string; sentById: string },
): Promise<boolean> {
  const invoice = await findInvoiceById(env, ctx, input.invoiceId);
  if (invoice === undefined) return false;

  const address = readDeliveryAddress(invoice.counterpartySnapshot);
  if (address === null) {
    // **宛先が無いことを黙って成功にしない。** 送ったつもりで
    // 送っていない状態を作らない。
    console.error("invoice-delivery-address-missing");
    return false;
  }

  const message: InvoiceDeliveryMessage = {
    kind: "INVOICE_DELIVERY",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    invoiceId: input.invoiceId,
    toEmail: address.toEmail,
    ccEmails: address.ccEmails,
    sentById: input.sentById,
    // **メッセージが時刻を持つ。** 再送で payload が変わらないようにする。
    requestedAtMs: ctx.now.getTime(),
  };

  try {
    await env.QUEUE_NOTIFICATION.send(message);
    return true;
  } catch {
    console.error("invoice-delivery-enqueue-failed");
    return false;
  }
}
