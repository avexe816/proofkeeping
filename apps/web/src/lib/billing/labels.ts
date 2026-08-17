/**
 * 請求まわりの語彙 → 文言キーと金額表示（W-12 契約と請求）。
 *
 * ── 訳を画面ごとに持たない ──────────────────────────────
 * 一覧と明細が同じ状態を別の言い方で出さないよう、対応表を 1 か所に置く
 * （`lib/reconciliation/labels.ts` と同じ判断）。
 *
 * ── 金額は整数（円）────────────────────────────────────
 * billing.md §4。浮動小数点を使わない。表示だけ 3 桁区切りにする。
 */

import type { InvoiceStatus } from "@pk/db";

import type { MessageKey } from "../i18n.js";

/** 請求書の状態（PK-SPEC-P5 §2.3）。 */
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, MessageKey> = {
  DRAFT: "billing.status.draft",
  CONFIRMED: "billing.status.confirmed",
  SENT: "billing.status.sent",
  VIEWED: "billing.status.viewed",
  PAID: "billing.status.paid",
  PARTIALLY_PAID: "billing.status.partiallyPaid",
  OVERDUE: "billing.status.overdue",
  VOIDED: "billing.status.voided",
};

/** 「1,619,244 円」。**単位は付けない**（呼び出し側が i18n キーで付ける）。 */
export function formatYenAmount(amount: number): string {
  return amount.toLocaleString("ja-JP");
}
