/**
 * 支払明細書 PDF のテンプレート（docs/PK-SPEC-PAY.md §3.2）。
 *
 * task:  docs/tasks/P5-18.md（作業ログ「未達（追送）」）
 * ルール: .claude/rules/billing.md §2（発行済みを消さない）/ security.md §5
 *
 * ── 控除の欄を作らない（PAY §0.2 MUST）──────────────────
 * 載るのは**支給総額の基礎**（タスク実績 × 単価 ＋ 調整行）まで。
 * 社会保険・源泉徴収・年末調整の枠をこのテンプレートへ足さないこと。
 * 「給与計算」の語も出さない。
 *
 * ── 仕入明細書方式（PAY §3.2）────────────────────────────
 * `isContractor` が真のとき、`contractorNotice`（相手方の確認を求める
 * 一文）と `contractorTaxNote`（税区分の注記欄）を**固定表示**する。
 * 文言は `PAYOUT_LABELS` の定数で、payload から差し替える経路が無い。
 *
 * ── JSX を使っていない・数値を再計算しない ──────────────
 * `invoice.ts` / `receipt.ts` と同じ理由。合計は payload の
 * `totalAmount`（確定時に固定された値）をそのまま出す。
 */

import type { PayoutStatementLine, PayoutStatementPayload } from "@pk/billing";
import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";

import { formatBusinessDate } from "./format.js";
import { PAYOUT_LABELS } from "./labels.js";
import type { InvoiceFont, InvoiceSeal } from "./invoice.js";

/** `renderToBuffer()` が受け取れる要素（`invoice.ts` と同じ理由）。 */
export type PayoutStatementDocument = Parameters<
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
    marginBottom: 16,
    flexDirection: "row",
  },
  amountLabel: { width: 90 },
  amountValue: { fontSize: 14 },
  payerBlock: { alignItems: "flex-end", marginBottom: 14 },
  payerRow: { flexDirection: "row", alignItems: "flex-end" },
  payerText: { alignItems: "flex-end" },
  seal: { width: 48, height: 48, marginLeft: 10 },
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
  notice: { marginTop: 20 },
  noticeLine: { marginBottom: 2 },
  empty: { paddingVertical: 4 },
});

/** 明細の列幅（合計 100）。No / 内容 / 数量 / 単位 / 単価 / 金額。 */
const LINE_WIDTHS = [6, 46, 9, 8, 15, 16] as const;

/** 金額（円）。**桁区切りを入れ、負なら先頭に `-`**（赤伝の調整行）。 */
function formatYen(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}¥${Math.abs(amount).toLocaleString("ja-JP")}`;
}

/** 単位（PAY §1.4 の quantity の解釈）。調整行（`null`）は「式」。 */
function unitLabelOf(unitType: PayoutStatementLine["unitType"]): string {
  if (unitType === "PER_TASK") return PAYOUT_LABELS.unitPerTask;
  if (unitType === "HOURLY") return PAYOUT_LABELS.unitHourly;
  return PAYOUT_LABELS.unitLump;
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
      style: [
        align === "right" ? styles.cellRight : styles.cell,
        { width: `${String(widthPercent)}%` },
      ],
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

function lineCells(line: PayoutStatementLine): string[] {
  return [
    String(line.lineNo),
    line.description,
    String(line.quantity),
    unitLabelOf(line.unitType),
    formatYen(line.unitPrice),
    formatYen(line.amount),
  ];
}

/** 空の値を落として 1 本の文字列にする（住所など）。 */
function joinParts(parts: readonly (string | null)[], separator = " "): string {
  return parts.filter((part): part is string => part !== null && part !== "").join(separator);
}

/**
 * 支払者（組織）の欄と角印。**請求書の発行事業者の欄と同じ組み方。**
 *
 * 登録番号の行は登録番号があるときだけ出す（`invoice.ts` と同じ理由）。
 */
function payerBlock(payload: PayoutStatementPayload, seal: InvoiceSeal): ReactElement {
  const { payer } = payload;
  const lines: ReactElement[] = [createElement(Text, { key: "name" }, payer.legalName)];
  if (payer.registrationNo !== null) {
    lines.push(
      createElement(Text, { key: "reg" }, `${PAYOUT_LABELS.registrationNo} ${payer.registrationNo}`),
    );
  }
  const address = joinParts([
    payer.postalCode === null ? null : `〒${payer.postalCode}`,
    payer.address,
  ]);
  if (address !== "") lines.push(createElement(Text, { key: "addr" }, address));
  if (payer.tel !== null) {
    lines.push(createElement(Text, { key: "tel" }, `${PAYOUT_LABELS.tel} ${payer.tel}`));
  }

  return createElement(
    View,
    { style: styles.payerBlock },
    createElement(
      View,
      { style: styles.payerRow },
      createElement(View, { style: styles.payerText }, ...lines),
      // 角印。**未設定なら枠ごと出さない。**
      seal === null ? null : createElement(Image, { style: styles.seal, src: seal.dataUrl }),
    ),
  );
}

/**
 * 宛先（支払を受けるスタッフ）。
 *
 * **表示名とスタッフ番号だけ**（security.md §5。住所・口座を載せない）。
 * 登録番号は CONTRACTOR かつ登録済みのときだけ出す（PAY §3.2）。
 */
function payeeBlock(payload: PayoutStatementPayload): ReactElement {
  const { payee } = payload;
  return createElement(
    View,
    { style: styles.addressee },
    createElement(
      Text,
      { style: styles.addresseeName },
      `${payee.displayName} ${PAYOUT_LABELS.honorific}`,
    ),
    payee.staffNumber === ""
      ? null
      : createElement(Text, { key: "no" }, `${PAYOUT_LABELS.staffNumber} ${payee.staffNumber}`),
    payload.isContractor && payee.registrationNo !== null
      ? createElement(
          Text,
          { key: "reg" },
          `${PAYOUT_LABELS.payeeRegistrationNo} ${payee.registrationNo}`,
        )
      : null,
  );
}

/**
 * 支払明細書の React 要素を組む。**描画（バイト列化）は `render.ts`。**
 *
 * @param seal 角印。**未設定なら `null`**（枠を出さない）。
 */
export function buildPayoutStatementDocument(
  payload: PayoutStatementPayload,
  font: InvoiceFont,
  seal: InvoiceSeal = null,
): PayoutStatementDocument {
  const fontFamily = font.kind === "EMBEDDED" ? font.family : "Helvetica";

  const lineRows =
    payload.lines.length === 0
      ? [
          createElement(
            View,
            { key: "empty", style: styles.empty },
            createElement(Text, null, PAYOUT_LABELS.none),
          ),
        ]
      : payload.lines.map((line) => row(lineCells(line), `line-${String(line.lineNo)}`));

  // 固定表示の注記（PAY §3.2）。**定数から読む。payload から差し替えられない。**
  const notices: ReactElement[] = [];
  if (payload.isContractor) {
    notices.push(
      createElement(
        Text,
        { key: "contractor", style: styles.noticeLine },
        PAYOUT_LABELS.contractorNotice,
      ),
      createElement(
        Text,
        { key: "tax", style: styles.noticeLine },
        PAYOUT_LABELS.contractorTaxNote,
      ),
    );
  }
  notices.push(
    createElement(
      Text,
      { key: "electronic", style: styles.noticeLine },
      PAYOUT_LABELS.electronicNotice,
    ),
  );

  return createElement(
    Document,
    null,
    createElement(
      Page,
      { size: "A4", style: [styles.page, { fontFamily }] },

      // 表題・文書番号・発行日。
      createElement(
        View,
        { style: styles.headerBlock },
        createElement(Text, { style: styles.title }, PAYOUT_LABELS.title),
        createElement(Text, { style: styles.documentNo }, payload.documentNo),
        createElement(
          Text,
          null,
          `${PAYOUT_LABELS.issueDate} ${formatBusinessDate(payload.issueDate)}`,
        ),
      ),

      payeeBlock(payload),
      createElement(Text, { style: styles.lead }, PAYOUT_LABELS.lead),

      // 合計（支給総額の基礎）。**payload の値そのまま。**
      createElement(
        View,
        { style: styles.amountBox },
        createElement(Text, { style: styles.amountLabel }, PAYOUT_LABELS.total),
        createElement(Text, { style: styles.amountValue }, formatYen(payload.totalAmount)),
      ),

      payerBlock(payload, seal),

      createElement(
        Text,
        { style: styles.period },
        `${PAYOUT_LABELS.period}: ${formatBusinessDate(payload.periodFrom)} 〜 ` +
          formatBusinessDate(payload.periodTo),
      ),

      // 明細。TASK 行（1〜）と調整行（1001〜）が番号順に並ぶ。
      row([...PAYOUT_LABELS.lineColumns], "line-head", true),
      ...lineRows,

      createElement(
        View,
        { style: styles.totalsBlock },
        createElement(
          View,
          { style: styles.totalsRow },
          createElement(Text, { style: styles.totalsLabel }, PAYOUT_LABELS.total),
          createElement(
            Text,
            { style: [styles.totalsValue, styles.grandTotal] },
            formatYen(payload.totalAmount),
          ),
        ),
      ),

      createElement(View, { style: styles.notice }, ...notices),
    ),
  );
}
