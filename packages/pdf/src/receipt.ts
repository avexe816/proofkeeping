/**
 * 領収書 PDF のテンプレート（PK-SPEC-P5 §8.2）。
 *
 * task:  docs/tasks/P5-08.md
 * ルール: .claude/rules/billing.md §3（印紙）・§1（適格請求書）・§2（電帳法）
 *
 * ── 印紙貼付欄を作らない（billing.md §3 MUST）───────────
 * PDF で発行・送付する領収書は紙の文書の交付にあたらないため課税文書に
 * 該当せず、**収入印紙は不要。5 万円超でも同じ。**
 *   - 印紙を貼る枠を置かない
 *   - 「収入印紙」「印紙税」の語を出さない
 *   - 代わりに `electronicNotice` を**固定表示**する（定数から読む。
 *     payload から差し替える経路が無い）
 * `receipt.spec.ts` がこの 3 つを固定する。
 *
 * ── JSX を使っていない ──────────────────────────────────
 * `dailyReport.ts` / `invoice.ts` と同じ理由。
 *
 * ── 数値を再計算しない ──────────────────────────────────
 * `payload` の値そのまま。**合計も税額もここで取らない。**
 */

import type { ReceiptPayload } from "@pk/billing";
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";

import { formatBusinessDate } from "./format.js";
import { RECEIPT_LABELS } from "./labels.js";
import type { InvoiceFont, InvoiceSeal } from "./invoice.js";

/** `renderToBuffer()` が受け取れる要素（`invoice.ts` と同じ理由）。 */
export type ReceiptDocument = Parameters<
  typeof import("@react-pdf/renderer").renderToBuffer
>[0];

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 40, paddingHorizontal: 40, fontSize: 10 },
  headerBlock: { alignItems: "flex-end", marginBottom: 24 },
  title: { fontSize: 20, marginBottom: 4 },
  documentNo: { fontSize: 10 },
  addresseeName: { fontSize: 13, marginBottom: 20 },
  amount: { fontSize: 22, marginBottom: 10 },
  purpose: { marginBottom: 2 },
  received: { marginBottom: 16 },
  sectionTitle: { fontSize: 11, marginTop: 8, marginBottom: 3 },
  breakdownRow: { flexDirection: "row", paddingVertical: 1, paddingLeft: 12 },
  breakdownLabel: { width: 140 },
  breakdownValue: { width: 110, textAlign: "right" },
  metaRow: { flexDirection: "row", paddingVertical: 1 },
  metaLabel: { width: 90 },
  issuerBlock: { alignItems: "flex-end", marginTop: 24 },
  issuerRow: { flexDirection: "row", alignItems: "flex-end" },
  issuerText: { alignItems: "flex-end" },
  seal: { width: 48, height: 48, marginLeft: 10 },
  notice: { marginTop: 28 },
  notQualified: { marginTop: 6 },
});

/** 金額（円）。**桁区切りを入れ、負なら先頭に `-`。** */
function formatYen(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}¥${Math.abs(amount).toLocaleString("ja-JP")}`;
}

/** 税率の表示（`10%` / `8%（軽減）`）。 */
function formatTaxRate(taxRate: number, isReducedRate: boolean): string {
  const base = `${String(taxRate)}%`;
  return isReducedRate ? `${base}（${RECEIPT_LABELS.reducedRate}）` : base;
}

/** 空の値を落として 1 本の文字列にする。 */
function joinParts(parts: readonly (string | null)[], separator = " "): string {
  return parts.filter((part): part is string => part !== null && part !== "").join(separator);
}

function metaRow(label: string, value: string, key: string): ReactElement {
  return createElement(
    View,
    { key, style: styles.metaRow },
    createElement(Text, { style: styles.metaLabel }, label),
    createElement(Text, null, value),
  );
}

/**
 * 発行事業者の欄と角印。
 *
 * **登録番号の行は登録番号があるときだけ出す**（`invoice.ts` と同じ理由）。
 */
function issuerBlock(payload: ReceiptPayload, seal: InvoiceSeal): ReactElement {
  const { issuer } = payload;
  const lines: ReactElement[] = [createElement(Text, { key: "name" }, issuer.legalName)];

  if (issuer.registrationNo !== null) {
    lines.push(
      createElement(
        Text,
        { key: "reg" },
        `${RECEIPT_LABELS.registrationNo} ${issuer.registrationNo}`,
      ),
    );
  }
  const address = joinParts([
    issuer.postalCode === null ? null : `〒${issuer.postalCode}`,
    issuer.address,
  ]);
  if (address !== "") lines.push(createElement(Text, { key: "addr" }, address));

  return createElement(
    View,
    { style: styles.issuerBlock },
    createElement(
      View,
      { style: styles.issuerRow },
      createElement(View, { style: styles.issuerText }, ...lines),
      // 角印。**未設定なら枠ごと出さない。**
      seal === null ? null : createElement(Image, { style: styles.seal, src: seal.dataUrl }),
    ),
  );
}

/**
 * 領収書の React 要素を組む。**描画（バイト列化）は `render.ts`。**
 *
 * @param seal 角印。**未設定なら `null`**（枠を出さない）。
 */
export function buildReceiptDocument(
  payload: ReceiptPayload,
  font: InvoiceFont,
  seal: InvoiceSeal = null,
): ReceiptDocument {
  const fontFamily = font.kind === "EMBEDDED" ? font.family : "Helvetica";

  const breakdown = payload.taxSummaries.flatMap((summary, index) => [
    createElement(
      View,
      { key: `sub-${String(index)}`, style: styles.breakdownRow },
      createElement(
        Text,
        { style: styles.breakdownLabel },
        `${formatTaxRate(summary.taxRate, summary.isReducedRate)} ${RECEIPT_LABELS.taxTargetSuffix}`,
      ),
      createElement(Text, { style: styles.breakdownValue }, formatYen(summary.subtotalAmount)),
    ),
    createElement(
      View,
      { key: `tax-${String(index)}`, style: styles.breakdownRow },
      createElement(Text, { style: styles.breakdownLabel }, RECEIPT_LABELS.taxAmount),
      createElement(Text, { style: styles.breakdownValue }, formatYen(summary.taxAmount)),
    ),
  ]);

  return createElement(
    Document,
    null,
    createElement(
      Page,
      { size: "A4", style: [styles.page, { fontFamily }] },

      createElement(
        View,
        { style: styles.headerBlock },
        createElement(Text, { style: styles.title }, RECEIPT_LABELS.title),
        createElement(Text, { style: styles.documentNo }, payload.documentNo),
        createElement(
          Text,
          null,
          `${RECEIPT_LABELS.issueDate} ${formatBusinessDate(payload.issueDate)}`,
        ),
      ),

      createElement(
        Text,
        { style: styles.addresseeName },
        `${payload.counterparty.legalName} ${RECEIPT_LABELS.honorific}`,
      ),

      // 金額。§8.2 は `¥1,113,860 -` の形。
      createElement(Text, { style: styles.amount }, `${formatYen(payload.receivedAmount)} -`),

      createElement(
        Text,
        { style: styles.purpose },
        `${RECEIPT_LABELS.purposePrefix} ${payload.purposeText}`,
      ),
      createElement(Text, { style: styles.received }, RECEIPT_LABELS.received),

      createElement(Text, { style: styles.sectionTitle }, RECEIPT_LABELS.breakdown),
      ...breakdown,

      createElement(
        View,
        { style: styles.sectionTitle },
        metaRow(RECEIPT_LABELS.paymentMethod, payload.paymentMethod, "method"),
        metaRow(
          RECEIPT_LABELS.receivedDate,
          formatBusinessDate(payload.receivedDate),
          "receivedDate",
        ),
        // **請求書に紐づかない領収書がありうる**（前受金など / §2.6）。
        payload.invoiceDocumentNo === null
          ? null
          : metaRow(RECEIPT_LABELS.targetInvoice, payload.invoiceDocumentNo, "invoice"),
      ),

      issuerBlock(payload, seal),

      payload.isQualifiedInvoice
        ? null
        : createElement(Text, { style: styles.notQualified }, RECEIPT_LABELS.notQualified),

      // **印紙が要らないことの固定表示**（billing.md §3 MUST）。
      // 定数から読む。payload から差し替えられない。
      createElement(Text, { style: styles.notice }, RECEIPT_LABELS.electronicNotice),
    ),
  );
}
