/**
 * 請求書 PDF のテンプレート（PK-SPEC-P5 §8.1）。
 *
 * task:  docs/tasks/P5-06.md
 * ルール: .claude/rules/billing.md §1（適格請求書の 6 要件）・§2（電帳法）
 *
 * ── JSX を使っていない ──────────────────────────────────
 * `dailyReport.ts` と同じ理由（あちらの冒頭の注記）。`.tsx` にすると
 * `pk/no-literal-string` が帳票の固定文言に掛かる。
 *
 * ── 数値を再計算しない ──────────────────────────────────
 * 表示するのは `payload` の値そのまま。**ここで合計も税額も取らない。**
 * 計算は `buildInvoiceDraft()`（P5-04）と発行時の確定（§4.1 の ③〜⑥）で
 * 済んでいる。テンプレートが足し直すと、**紙の数字と DB の数字が
 * 食い違う経路**ができる。
 *
 * ── 適格請求書の 6 要件（§1.1 MUST）─────────────────────
 * 6 つすべてがこのテンプレートに出る。対応は
 * `packages/billing/src/invoicePayload.ts` の表を参照。
 * **登録番号が未設定なら `notQualified` の但し書きを出す。**
 * 文言は `INVOICE_LABELS` から読み、payload から差し替えられない。
 *
 * ── 印紙貼付欄を作らない ────────────────────────────────
 * 領収書の話（billing.md §3）だが、請求書にも同じく置かない。
 * 「収入印紙」の枠をここへ足さないこと。
 */

import type { InvoicePayload, InvoicePayloadLine } from "@pk/billing";
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";

import { formatBusinessDate } from "./format.js";
import { INVOICE_LABELS } from "./labels.js";

/**
 * 使う書体。**日報と同じ**（`DailyReportFont`）。
 *
 * 既定の Helvetica は CJK のグリフを持たず、和文が空白になる。
 * 請求書は取引先へ送る文書なので、**読めない PDF を作らない。**
 */
export type InvoiceFont =
  | { kind: "EMBEDDED"; family: string; dataUrl: string }
  | { kind: "BUILT_IN_LATIN" };

/**
 * 角印（§8.1 の `[角印]`）。
 *
 * R2 の `sealImageKey` から読んだ画像を data URL で渡す
 * （フォントと同じ理由 / `lib/report/font.ts` の注記）。
 * **未設定なら `null`。** 枠だけを出さない。
 */
export type InvoiceSeal = { dataUrl: string } | null;

/** `renderToBuffer()` が受け取れる要素（`dailyReport.ts` と同じ理由）。 */
export type InvoiceDocument = Parameters<
  typeof import("@react-pdf/renderer").renderToBuffer
>[0];

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 36, paddingHorizontal: 36, fontSize: 9 },
  headerBlock: { alignItems: "flex-end", marginBottom: 18 },
  title: { fontSize: 18, marginBottom: 4 },
  documentNo: { fontSize: 10 },
  addressee: { marginBottom: 12 },
  addresseeName: { fontSize: 12, marginBottom: 2 },
  lead: { marginBottom: 10 },
  amountBox: {
    borderBottomWidth: 1,
    borderBottomColor: "#333333",
    paddingBottom: 4,
    marginBottom: 4,
    flexDirection: "row",
  },
  amountLabel: { width: 90 },
  amountValue: { fontSize: 14 },
  dueRow: { flexDirection: "row", marginBottom: 16 },
  dueLabel: { width: 90 },
  issuerBlock: { alignItems: "flex-end", marginBottom: 14 },
  issuerRow: { flexDirection: "row", alignItems: "flex-end" },
  issuerText: { alignItems: "flex-end" },
  seal: { width: 48, height: 48, marginLeft: 10 },
  notQualified: { marginTop: 6, marginBottom: 6 },
  period: { marginBottom: 6 },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#999999",
    paddingVertical: 3,
  },
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#333333",
    paddingVertical: 3,
  },
  cell: { paddingRight: 4 },
  cellRight: { paddingRight: 4, textAlign: "right" },
  totalsBlock: { marginTop: 8, alignItems: "flex-end" },
  totalsRow: { flexDirection: "row", paddingVertical: 2 },
  totalsLabel: { width: 120, textAlign: "right", paddingRight: 8 },
  totalsValue: { width: 90, textAlign: "right" },
  grandTotal: { fontSize: 12 },
  sectionTitle: { fontSize: 11, marginTop: 14, marginBottom: 3 },
  empty: { paddingVertical: 4 },
});

/** 明細の列幅（合計 100）。§8.1 の表の並び。 */
const LINE_WIDTHS = [5, 39, 8, 7, 13, 16, 12] as const;

/**
 * 金額（円）。**桁区切りを入れ、負なら先頭に `-`。**
 *
 * 赤伝（§5）はマイナス伝票なので、`¥-576,000` ではなく `-¥576,000` と
 * 出す。会計の慣行に合わせる。
 */
function formatYen(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}¥${Math.abs(amount).toLocaleString("ja-JP")}`;
}

/** 税率の表示（`10%` / `8%（軽減）`）。 */
function formatTaxRate(taxRate: number, isReducedRate: boolean): string {
  const base = `${String(taxRate)}%`;
  return isReducedRate ? `${base}（${INVOICE_LABELS.reducedRate}）` : base;
}

/** 数量。**整数なら小数点を出さない**（`180` を `180.0` にしない）。 */
function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(1);
}

function cell(
  text: string,
  widthPercent: number,
  key: string,
  align: "left" | "right" = "left",
): ReactElement {
  return createElement(
    View,
    {
      key,
      style: [align === "right" ? styles.cellRight : styles.cell, { width: `${String(widthPercent)}%` }],
    },
    createElement(Text, null, text),
  );
}

function row(
  cells: readonly string[],
  key: string,
  header = false,
  /** 右寄せにする列の番号。数量・単価・金額。 */
  rightAligned: readonly number[] = [2, 4, 5],
): ReactElement {
  return createElement(
    View,
    { key, style: header ? styles.headerRow : styles.row, wrap: false },
    ...cells.map((value, index) =>
      cell(
        value,
        LINE_WIDTHS[index] ?? 10,
        `${key}-${String(index)}`,
        !header && rightAligned.includes(index) ? "right" : "left",
      ),
    ),
  );
}

function lineCells(line: InvoicePayloadLine): string[] {
  return [
    String(line.lineNo),
    line.description,
    formatQuantity(line.quantity),
    line.unit,
    formatYen(line.unitPrice),
    formatYen(line.amount),
    formatTaxRate(line.taxRate, line.isReducedRate),
  ];
}

function totalsRow(label: string, value: string, key: string, grand = false): ReactElement {
  return createElement(
    View,
    { key, style: styles.totalsRow },
    createElement(Text, { style: styles.totalsLabel }, label),
    createElement(
      Text,
      { style: grand ? [styles.totalsValue, styles.grandTotal] : styles.totalsValue },
      value,
    ),
  );
}

/** 空の値を落として 1 本の文字列にする（住所・部署など）。 */
function joinParts(parts: readonly (string | null)[], separator = " "): string {
  return parts.filter((part): part is string => part !== null && part !== "").join(separator);
}

/**
 * 発行事業者の欄（§1.1 の 1 番）と角印。
 *
 * **登録番号の行は登録番号があるときだけ出す。** 空の
 * 「登録番号 」という行を出すと、番号を持っているのに印字漏れした
 * ように読める。持っていないことは `notQualified` の但し書きが述べる。
 */
function issuerBlock(payload: InvoicePayload, seal: InvoiceSeal): ReactElement {
  const { issuer } = payload;
  const lines: ReactElement[] = [
    createElement(Text, { key: "name" }, issuer.legalName),
  ];
  if (issuer.registrationNo !== null) {
    lines.push(
      createElement(
        Text,
        { key: "reg" },
        `${INVOICE_LABELS.registrationNo} ${issuer.registrationNo}`,
      ),
    );
  }
  const address = joinParts([issuer.postalCode === null ? null : `〒${issuer.postalCode}`, issuer.address]);
  if (address !== "") lines.push(createElement(Text, { key: "addr" }, address));
  if (issuer.tel !== null) {
    lines.push(createElement(Text, { key: "tel" }, `${INVOICE_LABELS.tel} ${issuer.tel}`));
  }

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

/** 宛先（§1.1 の 6 番）。 */
function addresseeBlock(payload: InvoicePayload): ReactElement {
  const { counterparty } = payload;
  const address = joinParts([
    counterparty.postalCode === null ? null : `〒${counterparty.postalCode}`,
    counterparty.address1,
    counterparty.address2,
  ]);
  const attention = joinParts([counterparty.department, counterparty.contactName]);

  return createElement(
    View,
    { style: styles.addressee },
    createElement(
      Text,
      { style: styles.addresseeName },
      `${counterparty.legalName} ${INVOICE_LABELS.honorific}`,
    ),
    address === "" ? null : createElement(Text, { key: "addr" }, address),
    attention === "" ? null : createElement(Text, { key: "attn" }, attention),
  );
}

/**
 * 税区分ごとの内訳（§1.1 の 4 番・5 番）。
 *
 * **税率ごとに 1 行。** `payload.taxSummaries` をそのまま並べる
 * （税率の高い順に並んでいる / `summarizeTax()`）。
 */
function taxBlock(payload: InvoicePayload): ReactElement[] {
  return payload.taxSummaries.map((summary, index) =>
    totalsRow(
      `${formatTaxRate(summary.taxRate, summary.isReducedRate)} ${INVOICE_LABELS.taxTargetSuffix}` +
        `  ${formatYen(summary.subtotalAmount)}  ${INVOICE_LABELS.taxAmount}`,
      formatYen(summary.taxAmount),
      `tax-${String(index)}`,
    ),
  );
}

/**
 * 請求書の React 要素を組む。**描画（バイト列化）は `render.ts`。**
 *
 * @param seal 角印。**未設定なら `null`**（枠を出さない）。
 */
export function buildInvoiceDocument(
  payload: InvoicePayload,
  font: InvoiceFont,
  seal: InvoiceSeal = null,
): InvoiceDocument {
  const fontFamily = font.kind === "EMBEDDED" ? font.family : "Helvetica";

  const lineRows =
    payload.lines.length === 0
      ? [
          createElement(
            View,
            { key: "empty", style: styles.empty },
            createElement(Text, null, INVOICE_LABELS.none),
          ),
        ]
      : payload.lines.map((line) => row(lineCells(line), `line-${String(line.lineNo)}`));

  return createElement(
    Document,
    null,
    createElement(
      Page,
      { size: "A4", style: [styles.page, { fontFamily }] },

      // 表題と文書番号（§8.1 の右上）。
      createElement(
        View,
        { style: styles.headerBlock },
        createElement(
          Text,
          { style: styles.title },
          payload.isCreditNote ? INVOICE_LABELS.creditNoteTitle : INVOICE_LABELS.title,
        ),
        createElement(Text, { style: styles.documentNo }, payload.documentNo),
        createElement(
          Text,
          null,
          `${INVOICE_LABELS.issueDate} ${formatBusinessDate(payload.issueDate)}`,
        ),
      ),

      addresseeBlock(payload),
      createElement(Text, { style: styles.lead }, INVOICE_LABELS.lead),

      // ご請求金額とお支払期限。
      createElement(
        View,
        { style: styles.amountBox },
        createElement(Text, { style: styles.amountLabel }, INVOICE_LABELS.totalDue),
        createElement(Text, { style: styles.amountValue }, formatYen(payload.totalAmount)),
      ),
      createElement(
        View,
        { style: styles.dueRow },
        createElement(Text, { style: styles.dueLabel }, INVOICE_LABELS.dueDate),
        createElement(Text, null, formatBusinessDate(payload.dueDate)),
      ),

      issuerBlock(payload, seal),

      // **適格請求書でないことの明示**（§1.1 MUST）。
      payload.isQualifiedInvoice
        ? null
        : createElement(Text, { style: styles.notQualified }, INVOICE_LABELS.notQualified),

      createElement(
        Text,
        { style: styles.period },
        `${INVOICE_LABELS.period}: ${formatBusinessDate(payload.periodFrom)} 〜 ` +
          formatBusinessDate(payload.periodTo),
      ),

      // 明細（§1.1 の 2 番・3 番）。
      row([...INVOICE_LABELS.lineColumns], "line-head", true),
      ...lineRows,

      // 小計・税区分・合計（§1.1 の 4 番・5 番）。
      createElement(
        View,
        { style: styles.totalsBlock },
        totalsRow(INVOICE_LABELS.subtotal, formatYen(payload.subtotalAmount), "subtotal"),
        ...taxBlock(payload),
        totalsRow(INVOICE_LABELS.total, formatYen(payload.totalAmount), "total", true),
      ),

      // 振込先。**未設定なら節ごと出さない**（空欄の枠を載せない）。
      payload.bankAccountText === null
        ? null
        : createElement(
            View,
            null,
            createElement(Text, { style: styles.sectionTitle }, INVOICE_LABELS.bankAccount),
            createElement(Text, null, payload.bankAccountText),
          ),

      payload.note === null
        ? null
        : createElement(
            View,
            null,
            createElement(Text, { style: styles.sectionTitle }, INVOICE_LABELS.note),
            createElement(Text, null, payload.note),
          ),
    ),
  );
}
