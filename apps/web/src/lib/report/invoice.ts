/**
 * 請求書 PDF の材料集め（PK-SPEC-P5 §8.1）。
 *
 * task:  docs/tasks/P5-06.md
 * ルール: .claude/rules/billing.md §1・§6
 *
 * ── ここは読むだけ ──────────────────────────────────────
 * DB から**発行時に固定された値**を読んで `InvoicePayload` に組む。
 * **合計も税額もここで取らない**（`invoice` の列と
 * `invoice_tax_summary` の行をそのまま載せる）。計算は発行の瞬間
 * （§4.1 の ③〜⑥）に済んでいて、紙はその写し。
 *
 * ── マスタを引き直さない（billing.md §6）────────────────
 * 発行元・取引先は `issuerSnapshot` / `counterpartySnapshot` から読む。
 * `organizationTaxProfile` や `counterparty` を引くと、**住所を直した
 * 瞬間に過去の請求書の見た目が変わる。** 唯一の例外が角印で、
 * これは画像の実体が R2 にあり、帳票に焼き込めない（下の注記）。
 *
 * ── 呼ぶのは Queue コンシューマ ─────────────────────────
 * §8.3 MUST。リクエストハンドラから呼ばない。
 */

import type { InvoiceCounterpartySnapshot, InvoiceIssuerSnapshot, InvoicePayload } from "@pk/billing";
import {
  findInvoiceById,
  listInvoiceLines,
  listInvoiceTaxSummaries,
  type Env,
  type TenantContext,
} from "@pk/db";
import type { InvoiceSeal } from "@pk/pdf";

/** `DOCUMENTS` バケットの請求書の接頭辞。**日報・角印とは別。** */
export const INVOICE_PDF_PREFIX = "invoices";

/**
 * 請求書 PDF の R2 キー。
 *
 * **版（`revision`）を含める。** 訂正は赤伝＋再発行で別の文書になるが、
 * 同じ文書の PDF を作り直すこと（§9 の `regenerate-pdf`）はある。
 * 版を含めないと、元の PDF が上書きされて**閲覧可能なまま維持する**
 * という電帳法の要件（billing.md §2）を割る。
 */
export function invoicePdfKey(input: {
  organizationId: string;
  documentNo: string;
  revision: number;
}): string {
  return (
    `${INVOICE_PDF_PREFIX}/${input.organizationId}/${input.documentNo}` +
    `-r${String(input.revision)}.pdf`
  );
}

/** 送付・保存に使うファイル名（取引先が見る名前）。 */
export function invoicePdfFileName(documentNo: string): string {
  return `${documentNo}.pdf`;
}

/**
 * スナップショットの JSON から発行元を読む。
 *
 * **形が違っても落とさない。** スナップショットは発行時に固定した
 * `Record<string, unknown>` で、列の型が保証しているのは「JSON である」
 * ことだけ。読めない項目は `null` にし、**名称だけは必須**にする
 * （§1.1 の 1 番。発行事業者の名前が無い請求書は出せない）。
 */
export function readIssuerSnapshot(value: Record<string, unknown>): InvoiceIssuerSnapshot | null {
  const legalName = str(value["legalName"]);
  if (legalName === null) return null;
  return {
    legalName,
    registrationNo: str(value["registrationNo"] ?? value["invoiceRegistrationNumber"]),
    postalCode: str(value["postalCode"]),
    address: str(value["address"]),
    tel: str(value["tel"]),
  };
}

/** 同上、交付を受ける事業者（§1.1 の 6 番）。 */
export function readCounterpartySnapshot(
  value: Record<string, unknown>,
): InvoiceCounterpartySnapshot | null {
  const legalName = str(value["legalName"]);
  if (legalName === null) return null;
  return {
    legalName,
    postalCode: str(value["postalCode"]),
    address1: str(value["address1"]),
    address2: str(value["address2"]),
    department: str(value["department"]),
    contactName: str(value["contactName"]),
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * PDF を作るのに要るもの。
 *
 * **`revision` は payload の外。** 紙に版は出ない（§8.1 の見本に無い）が、
 * R2 のキーには要る（`invoicePdfKey()`）。紙に載る値と載らない値を
 * 混ぜないため、payload とは別の場所に置く。
 */
export interface InvoicePdfSource {
  payload: InvoicePayload;
  revision: number;
}

/**
 * 請求書 1 通ぶんの payload を組む。**見つからなければ `null`。**
 *
 * `null` は「再送しても直らない」を意味する（コンシューマが ack する）。
 * 越境した ID は `findInvoiceById()` が DB へ行く前に `NotFoundError` を
 * 投げるので、ここへは届かない。
 */
export async function collectInvoicePayload(
  env: Env,
  ctx: TenantContext,
  invoiceId: string,
): Promise<InvoicePdfSource | null> {
  const invoice = await findInvoiceById(env, ctx, invoiceId);
  if (invoice === undefined) return null;

  const issuer = readIssuerSnapshot(invoice.issuerSnapshot);
  const counterparty = readCounterpartySnapshot(invoice.counterpartySnapshot);
  if (issuer === null || counterparty === null) return null;

  const [lines, taxSummaries] = await Promise.all([
    listInvoiceLines(env, ctx, invoiceId),
    listInvoiceTaxSummaries(env, ctx, invoiceId),
  ]);

  const payload: InvoicePayload = {
    documentNo: invoice.documentNo,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    periodFrom: invoice.periodFrom,
    periodTo: invoice.periodTo,
    isQualifiedInvoice: invoice.isQualifiedInvoice,
    isCreditNote: invoice.isCreditNote,
    issuer,
    counterparty,
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      serviceDateFrom: line.serviceDateFrom,
      serviceDateTo: line.serviceDateTo,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taxRate: line.taxRate,
      isReducedRate: line.isReducedRate,
    })),
    taxSummaries: taxSummaries.map((summary) => ({
      taxRate: summary.taxRate,
      isReducedRate: summary.isReducedRate,
      subtotalAmount: summary.subtotalAmount,
      taxAmount: summary.taxAmount,
      totalAmount: summary.totalAmount,
    })),
    subtotalAmount: invoice.subtotalAmount,
    taxAmount: invoice.taxAmount,
    totalAmount: invoice.totalAmount,
    // **振込先の列がまだ無い**（docs/OPEN_QUESTIONS.md #073）。
    // `null` を渡すとテンプレートが節ごと出さない。空欄の枠を載せない。
    bankAccountText: str(invoice.issuerSnapshot["bankAccountText"]),
    note: invoice.note,
  };

  return { payload, revision: invoice.revision };
}

/**
 * 角印を読む（§8.1 の `[角印]`）。
 *
 * ── スナップショットに焼き込めない ──────────────────────
 * 画像の実体は R2 にあり、帳票の JSON には入らない。**キーだけを
 * スナップショットに残し、実体はそのつど読む**（`sealImageKey`）。
 * 印影を差し替えれば過去の請求書を作り直したときの見た目も変わるが、
 * 角印は「その会社の印」であって取引ごとの事実ではないので、
 * 最新のものが載ってよい。
 *
 * **無ければ `null`。** 押されていない請求書は成立する（角印は
 * 法令上の要件ではない / §1.1 の 6 要件に入っていない）。フォントと
 * 違って、欠けても「読めない PDF」にはならないため失敗にしない。
 */
export async function loadInvoiceSeal(env: Env, sealImageKey: string | null): Promise<InvoiceSeal> {
  if (sealImageKey === null) return null;

  const object = await env.DOCUMENTS.get(sealImageKey);
  if (object === null) return null;

  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType ?? "image/png";
  return { dataUrl: `data:${contentType};base64,${base64Of(bytes)}` };
}

/**
 * バイト列を base64 に直す。
 *
 * **`btoa()` に長い文字列を一度に渡さない。** 角印は 1MB まで
 * （contracts の `SEAL_IMAGE.maxBytes`）で、`String.fromCharCode(...bytes)`
 * は引数の数が上限を超えて落ちる。`lib/report/font.ts` と同じ刻み方。
 */
function base64Of(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}
