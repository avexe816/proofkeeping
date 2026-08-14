/**
 * 領収書の送付と PDF の投入（PK-SPEC-P5 §4.2 の ④⑤）。
 *
 * task: docs/tasks/P5-08.md
 *
 * 宛先は**スナップショットから**取る（`deliver.ts` と同じ理由 /
 * billing.md §6）。発行後に請求先メールを変えても、その領収書は
 * 発行時の宛先へ送られる。
 */

import { findReceiptById, type Env, type TenantContext } from "@pk/db";

import type { ReceiptPdfMessage } from "../../consumers/invoicePdf.js";
import type { ReceiptDeliveryMessage } from "../../consumers/notification.js";

import { readDeliveryAddress } from "./deliver.js";

/** PDF 生成をキューへ投げる（④）。**失敗を例外にしない。** */
export async function enqueueReceiptPdf(
  env: Env,
  ctx: TenantContext,
  input: { receiptId: string; sealImageKey: string | null },
): Promise<boolean> {
  const message: ReceiptPdfMessage = {
    kind: "RECEIPT_PDF",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    receiptId: input.receiptId,
    sealImageKey: input.sealImageKey,
    requestedAtMs: ctx.now.getTime(),
  };
  try {
    await env.QUEUE_PDF_GENERATION.send(message);
    return true;
  } catch {
    console.error("receipt-pdf-enqueue-failed");
    return false;
  }
}

/** 送付をキューへ投げる（⑤）。**宛先が読めないときも `false`。** */
export async function enqueueReceiptDelivery(
  env: Env,
  ctx: TenantContext,
  input: { receiptId: string; sentById: string },
): Promise<boolean> {
  const receipt = await findReceiptById(env, ctx, input.receiptId);
  if (receipt === undefined) return false;

  const address = readDeliveryAddress(receipt.counterpartySnapshot);
  if (address === null) {
    // **宛先が無いことを黙って成功にしない**（`deliver.ts` と同じ）。
    console.error("receipt-delivery-address-missing");
    return false;
  }

  const message: ReceiptDeliveryMessage = {
    kind: "RECEIPT_DELIVERY",
    organizationId: ctx.organizationId,
    orgShortId: ctx.orgShortId,
    receiptId: input.receiptId,
    toEmail: address.toEmail,
    ccEmails: address.ccEmails,
    sentById: input.sentById,
    requestedAtMs: ctx.now.getTime(),
  };

  try {
    await env.QUEUE_NOTIFICATION.send(message);
    return true;
  } catch {
    console.error("receipt-delivery-enqueue-failed");
    return false;
  }
}
