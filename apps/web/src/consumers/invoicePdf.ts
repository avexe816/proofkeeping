/**
 * 請求書 PDF の生成（PK-SPEC-P5 §8.1・§8.3）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P5-06.md
 * ルール: .claude/rules/architecture.md §5 / billing.md §1・§2
 *
 * ```
 * POST /api/v1/invoices/issue-and-send   → QUEUE_PDF_GENERATION（P5-07）
 * POST /api/v1/invoices/:id/regenerate-pdf →     同上
 *                                        ← ここで PDF を作り R2 へ
 * ```
 *
 * ── なぜ Queue なのか（§8.3 MUST / P5-06 の完了条件）────
 * `@react-pdf/renderer` はレイアウトと書体の埋め込みを行う。明細が
 * 数十行あると数百 ms かかり、**リクエストの CPU 予算（50ms）に
 * 収まらない。** `renderInvoicePdf()` は Queue の中からしか呼ばない。
 *
 * ── 投入する側はまだ無い ────────────────────────────────
 * 発行フロー（§4.1 の ⑦）は P5-07。**このコンシューマは先に完成させて
 * よい**（P5-01 が書き込みの無いスキーマを先に置いたのと同じ）。
 * 逆に「発行の一部だけ」を先に作らないこと（§4.1 の ①〜⑥ は
 * 1 トランザクション）。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても結果が変わらない。
 *   ① R2 のキーが `(組織, 文書番号, 版)` で決まる。3 回作れば同じキーへ
 *      同じ内容が載る。
 *   ② payload は発行時に固定された値から毎回組み直す。**差分を足さない。**
 *   ③ 行を作らないので、行が増えることもない。
 * ⑧ の `pdfSha256` と ⑨ の R2 キーはここで書き戻す（P5-07 が足した）。
 * **触ってよいのは `pdfStorageKey` / `pdfSha256` だけ**（`updateInvoicePdf()`）。
 * 金額と明細に触れる経路をコンシューマに持たせない（billing.md §2）。
 * 3 回処理しても同じキーに同じ値が入る。
 *
 * ── 消さない・上書きしない ──────────────────────────────
 * 版を上げた再発行は別のキーになる。元の PDF は**閲覧可能なまま
 * 維持する**（billing.md §2）。削除の経路をこのファイルへ足さないこと。
 */

import { updateInvoicePdf, updatePayoutPdf, updateReceiptPdf, type Env, type TenantContext } from "@pk/db";
import { renderInvoicePdf, renderPayoutStatementPdf, renderReceiptPdf } from "@pk/pdf";

import { sha256Hex } from "../lib/evidence/hash.js";

import { loadDailyReportFont } from "../lib/report/font.js";
import {
  collectInvoicePayload,
  collectReceiptPayload,
  invoicePdfKey,
  loadInvoiceSeal,
  receiptPdfKey,
} from "../lib/report/invoice.js";
import { collectPayoutStatementPayload, payoutPdfKey } from "../lib/report/payout.js";

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface InvoicePdfMessage {
  kind: "INVOICE_PDF";
  organizationId: string;
  orgShortId: string;
  invoiceId: string;
  /**
   * 角印画像の R2 キー。**投入側が渡す**（コンシューマが税務プロファイルを
   * 引き直さない / `lib/report/invoice.ts` の注記）。未設定なら `null`。
   */
  sealImageKey: string | null;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない**（冒頭の「冪等」）。 */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isInvoicePdfMessage(value: unknown): value is InvoicePdfMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "INVOICE_PDF" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["invoiceId"] === "string" &&
    (message["sealImageKey"] === null || typeof message["sealImageKey"] === "string") &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type InvoicePdfOutcome =
  | { kind: "OK"; key: string; bytes: number }
  /** 請求書が無い・スナップショットが読めない。**再送しても直らない。** */
  | { kind: "SKIPPED"; reason: string }
  /** R2 / D1 / 書体の不足。**直しうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/**
 * 請求書 PDF を 1 通作る。
 *
 * **同じ文書・同じ版を作り直すと同じキーへ同じ内容が載る**（冒頭の「冪等」）。
 */
export async function generateInvoicePdf(
  env: Env,
  message: InvoicePdfMessage,
): Promise<InvoicePdfOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    // バッチと同じ扱い（`consumers/dailyReport.ts` の注記 / OPEN_QUESTIONS #033）。
    // **`assertPermission()` は呼ばない。** 認可は投入した API 側で済んでいる。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  try {
    const source = await collectInvoicePayload(env, ctx, message.invoiceId);
    if (source === null) return { kind: "SKIPPED", reason: "INVOICE_NOT_FOUND" };
    const { payload, revision } = source;

    // **和文の書体が無ければ作らない。** 「動いているのに読めない PDF」を
    // 取引先へ送らない（`packages/pdf/src/dailyReport.ts` の注記）。
    const font = await loadDailyReportFont(env);
    if (font === null) return { kind: "FAILED", reason: "FONT_NOT_FOUND" };

    // 角印は無くても請求書は成立する（§1.1 の 6 要件に入っていない）。
    const seal = await loadInvoiceSeal(env, message.sealImageKey);

    const bytes = await renderInvoicePdf(payload, font, seal);
    const key = invoicePdfKey({
      organizationId: message.organizationId,
      documentNo: payload.documentNo,
      revision,
    });

    await env.DOCUMENTS.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });

    // ⑧⑨ 在り処とハッシュを書き戻す。**金額と明細には触らない。**
    // R2 へ置いたあとに書く。**先に書くと、PDF が無いのに
    // 「ある」と記録された請求書ができる。**
    await updateInvoicePdf(env, ctx, message.invoiceId, {
      pdfStorageKey: key,
      pdfSha256: await sha256Hex(bytes),
    });

    return { kind: "OK", key, bytes: bytes.byteLength };
  } catch (error) {
    // **中身をログへ流さない。** 例外の名前だけ（architecture.md §1）。
    // 文書番号も出さない（取引の内容が推測できる）。
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`invoice-pdf-failed reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}


// ────────────────────────────────────────────────────────────
// 領収書（P5-08 / PK-SPEC-P5 §8.2・§4.2 の ④）
// ────────────────────────────────────────────────────────────

/** キューへ載せるメッセージ。**請求書と同じ `pk-pdf-generation`。** */
export interface ReceiptPdfMessage {
  kind: "RECEIPT_PDF";
  organizationId: string;
  orgShortId: string;
  receiptId: string;
  sealImageKey: string | null;
  requestedAtMs: number;
}

/** メッセージの形を確かめる。 */
export function isReceiptPdfMessage(value: unknown): value is ReceiptPdfMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "RECEIPT_PDF" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["receiptId"] === "string" &&
    (message["sealImageKey"] === null || typeof message["sealImageKey"] === "string") &&
    typeof message["requestedAtMs"] === "number"
  );
}

/**
 * 領収書 PDF を 1 通作る（§4.2 の ④）。
 *
 * **印紙貼付欄を持たない**（billing.md §3）。電子発行の注記は
 * テンプレートが定数から出す。この関数から差し替える経路は無い。
 */
export async function generateReceiptPdf(
  env: Env,
  message: ReceiptPdfMessage,
): Promise<InvoicePdfOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  try {
    const source = await collectReceiptPayload(env, ctx, message.receiptId);
    if (source === null) return { kind: "SKIPPED", reason: "RECEIPT_NOT_FOUND" };
    const { payload, revision } = source;

    const font = await loadDailyReportFont(env);
    if (font === null) return { kind: "FAILED", reason: "FONT_NOT_FOUND" };

    const seal = await loadInvoiceSeal(env, message.sealImageKey);
    const bytes = await renderReceiptPdf(payload, font, seal);
    const key = receiptPdfKey({
      organizationId: message.organizationId,
      documentNo: payload.documentNo,
      revision,
    });

    await env.DOCUMENTS.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });

    // **R2 へ置いたあとに書く**（`generateInvoicePdf()` と同じ理由）。
    await updateReceiptPdf(env, ctx, message.receiptId, {
      pdfStorageKey: key,
      pdfSha256: await sha256Hex(bytes),
    });

    return { kind: "OK", key, bytes: bytes.byteLength };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`receipt-pdf-failed reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}


// ────────────────────────────────────────────────────────────
// 支払明細書（P5-18 追送 / docs/PK-SPEC-PAY.md §3.2）
// ────────────────────────────────────────────────────────────

/** キューへ載せるメッセージ。**請求書・領収書と同じ `pk-pdf-generation`。** */
export interface PayoutPdfMessage {
  kind: "PAYOUT_PDF";
  organizationId: string;
  orgShortId: string;
  payoutPeriodId: string;
  sealImageKey: string | null;
  requestedAtMs: number;
}

/** メッセージの形を確かめる。 */
export function isPayoutPdfMessage(value: unknown): value is PayoutPdfMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message["kind"] === "PAYOUT_PDF" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["payoutPeriodId"] === "string" &&
    (message["sealImageKey"] === null || typeof message["sealImageKey"] === "string") &&
    typeof message["requestedAtMs"] === "number"
  );
}

/**
 * 支払明細書 PDF を 1 通作る（PAY §3.2）。
 *
 * **冪等。** R2 のキーは `(組織, 文書番号)` で決まり（版が無い —
 * `payoutPdfKey()` の注記）、payload は確定時に固定された値から
 * 毎回組み直す。3 回処理しても同じキーへ同じ内容が載る。
 *
 * **触ってよいのは `pdfStorageKey` / `pdfSha256` だけ**（`updatePayoutPdf()`）。
 * 金額と明細に触れる経路をコンシューマに持たせない（billing.md §2）。
 */
export async function generatePayoutStatementPdf(
  env: Env,
  message: PayoutPdfMessage,
): Promise<InvoicePdfOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  try {
    // CONFIRMED 以外・採番前は `null`（再送しても直らない → ack）。
    const payload = await collectPayoutStatementPayload(env, ctx, message.payoutPeriodId);
    if (payload === null) return { kind: "SKIPPED", reason: "PAYOUT_NOT_CONFIRMED" };

    const font = await loadDailyReportFont(env);
    if (font === null) return { kind: "FAILED", reason: "FONT_NOT_FOUND" };

    // 角印は無くても支払明細書は成立する（請求書と同じ扱い）。
    const seal = await loadInvoiceSeal(env, message.sealImageKey);

    const bytes = await renderPayoutStatementPdf(payload, font, seal);
    const key = payoutPdfKey({
      organizationId: message.organizationId,
      documentNo: payload.documentNo,
    });

    await env.DOCUMENTS.put(key, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });

    // **R2 へ置いたあとに書く**（`generateInvoicePdf()` と同じ理由）。
    await updatePayoutPdf(env, ctx, message.payoutPeriodId, {
      pdfStorageKey: key,
      pdfSha256: await sha256Hex(bytes),
    });

    return { kind: "OK", key, bytes: bytes.byteLength };
  } catch (error) {
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`payout-pdf-failed reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}
