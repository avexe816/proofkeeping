/**
 * 訂正（赤伝＋再発行）（PK-SPEC-P5 §5）。
 *
 * task:  docs/tasks/P5-09.md
 * ルール: .claude/rules/billing.md §2（電帳法）・§5（採番）
 *
 * ```
 * 1. 元請求書の [ 訂正する ] を押す
 * 2. 訂正理由を入力（必須）
 * 3. 赤伝が自動生成され、元請求書が VOIDED になる
 * 4. 締めを差し戻す（再発行できる状態へ）
 * 5. 修正して発行（= 既存の issue-and-send をもう一度）
 * 6. 赤伝と再発行分の 2 通を同時にメール送付
 * ```
 *
 * ── 元の行を書き換えない（§5.1）─────────────────────────
 * 赤伝は**新しい請求書**（`isCreditNote = true`）。元の請求書は
 * `status` と `voidedAt` / `voidReason` だけが変わり、**金額も明細も
 * PDF も動かない。**
 *
 * ── 元の PDF を残す（§5.2 MUST）─────────────────────────
 * `voidInvoice()` は `pdfStorageKey` に触らない。ダウンロードの経路も
 * `VOIDED` を弾かない（`routes/api/v1/invoices.ts` の `download`）。
 *
 * ── 番号は欠番のまま（§5.3）─────────────────────────────
 * 赤伝は**新しい番号**を採る。元の番号は使われたまま残り、再利用しない。
 * `DocumentSequencer` は減らない。
 *
 * ── 税額が 1 円ずれない ─────────────────────────────────
 * 赤伝の税額は元伝票の符号違いにちょうど一致する。`calcTaxAmount()` が
 * **絶対値を丸めてから符号を戻す**ためで、`Math.floor()` で実装して
 * いたら -1235 と -1234 に割れていた（`tax.ts` の注記）。
 */

import { evaluateBillingPeriodTransition, fiscalYearOf, summarizeTax } from "@pk/billing";
import {
  createInvoice,
  findInvoiceById,
  findTaxProfile,
  listBillingPeriods,
  listInvoiceLines,
  updateBillingPeriodStatus,
  voidInvoice,
  type Env,
  type TenantContext,
} from "@pk/db";
import { canonicalJson } from "@pk/engine";

import { issueDocumentNumber } from "../document/sequencer.js";
import { sha256HexOfText } from "../evidence/hash.js";

import { enqueueInvoiceDelivery } from "./deliver.js";
import { enqueueInvoicePdf } from "./issue.js";

/** 訂正の結果。 */
export type CorrectInvoiceOutcome =
  | {
      kind: "CORRECTED";
      creditNoteId: string;
      creditNoteDocumentNo: string;
      /** 締めを差し戻せたか。**偽なら再発行の口が開かない**（要調査）。 */
      periodReopened: boolean;
    }
  | { kind: "REJECTED"; reason: CorrectInvoiceRejectReason };

export type CorrectInvoiceRejectReason =
  | "INVOICE_NOT_FOUND"
  | "ALREADY_VOIDED"
  /** 赤伝そのものは訂正できない（赤伝の赤伝を作らない）。 */
  | "IS_CREDIT_NOTE"
  | "TAX_PROFILE_NOT_FOUND";

export interface CorrectInvoiceInput {
  invoiceId: string;
  /** 訂正理由（§5.2 の 2。**必須**）。 */
  reason: string;
  actorId: string;
  /** 発行日（`YYYY-MM-DD`）。 */
  issueDate: string;
}

/**
 * 赤伝を切り、元請求書を取り消す（§5.2 の 1〜4）。
 *
 * **再発行（5）はしない。** 元の明細をそのまま出し直すのではなく、
 * 料金設定やタスクを直してから `issue-and-send` をもう一度叩く
 * （§5.2 の 4「編集画面が開く」に当たる操作は画面の仕事）。
 * ここは締めを差し戻して、その口が開く状態にするところまで。
 */
export async function correctInvoice(
  env: Env,
  ctx: TenantContext,
  input: CorrectInvoiceInput,
): Promise<CorrectInvoiceOutcome> {
  const original = await findInvoiceById(env, ctx, input.invoiceId);
  if (original === undefined) return { kind: "REJECTED", reason: "INVOICE_NOT_FOUND" };
  if (original.status === "VOIDED") return { kind: "REJECTED", reason: "ALREADY_VOIDED" };
  // **赤伝の赤伝を作らない。** 訂正するのは元の請求書。
  if (original.isCreditNote) return { kind: "REJECTED", reason: "IS_CREDIT_NOTE" };

  const taxProfile = await findTaxProfile(env, ctx);
  if (taxProfile === undefined) return { kind: "REJECTED", reason: "TAX_PROFILE_NOT_FOUND" };

  const lines = await listInvoiceLines(env, ctx, input.invoiceId);

  // ③ まず取り消す。**ここが取れなければ赤伝を切らない**（番号を無駄に
  // 消費しない / 2 回押しても赤伝が 2 通出ない）。
  const voided = await voidInvoice(env, ctx, input.invoiceId, {
    reason: input.reason,
    voidedAt: ctx.now,
  });
  if (voided === 0) return { kind: "REJECTED", reason: "ALREADY_VOIDED" };

  // 明細を符号反転する。**`unitPrice` は変えない**（単価は事実）。
  const creditLines = lines.map((line) => ({
    lineNo: line.lineNo,
    propertyId: line.propertyId,
    itemCode: line.itemCode,
    description: line.description,
    serviceDateFrom: line.serviceDateFrom,
    serviceDateTo: line.serviceDateTo,
    quantity: -line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    amount: -line.amount,
    taxRate: line.taxRate,
    isReducedRate: line.isReducedRate,
    sourceRef: line.sourceRef,
  }));

  // **税額を引き直す。** 元の行を反転して足すのではなく、税率ごとに
  // 1 回だけ丸め直す（§2.5 MUST）。符号対称な丸めなので、結果は
  // 元伝票の符号違いにちょうど一致する（冒頭の注記）。
  const creditTaxSummaries = summarizeTax(
    creditLines.map((line) => ({
      amount: line.amount,
      taxRate: line.taxRate,
      isReducedRate: line.isReducedRate,
    })),
    taxProfile.defaultTaxRoundingMode,
  );

  const subtotalAmount = creditTaxSummaries.reduce((sum, entry) => sum + entry.subtotalAmount, 0);
  const taxAmount = creditTaxSummaries.reduce((sum, entry) => sum + entry.taxAmount, 0);
  const totalAmount = subtotalAmount + taxAmount;

  // ② 赤伝の採番。**新しい番号**（元の番号は欠番のまま残る / §5.3）。
  const fiscalYear = fiscalYearOf(input.issueDate, taxProfile.fiscalYearStartMonth);
  const issued = await issueDocumentNumber(env, {
    organizationId: ctx.organizationId,
    documentType: "INVOICE",
    fiscalYear,
  });

  const payloadSha256 = await sha256HexOfText(
    canonicalJson({
      documentNo: issued.documentNumber,
      creditNoteFor: original.documentNo,
      issueDate: input.issueDate,
      subtotalAmount,
      taxAmount,
      totalAmount,
      lines: creditLines.map((line) => ({
        lineNo: line.lineNo,
        itemCode: line.itemCode,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.amount,
        taxRate: line.taxRate,
        isReducedRate: line.isReducedRate,
      })),
    }),
  );

  // ③ 赤伝を作る。**スナップショットは元請求書のものを引き継ぐ**
  // （billing.md §6。訂正のたびに宛先が変わってはならない）。
  const { invoiceId: creditNoteId } = await createInvoice(env, ctx, {
    counterpartyId: original.counterpartyId,
    documentNo: issued.documentNumber,
    issueDate: input.issueDate,
    dueDate: original.dueDate,
    periodFrom: original.periodFrom,
    periodTo: original.periodTo,
    counterpartyName: original.counterpartyName,
    subtotalAmount,
    taxAmount,
    totalAmount,
    isQualifiedInvoice: original.isQualifiedInvoice,
    issuerSnapshot: original.issuerSnapshot,
    counterpartySnapshot: original.counterpartySnapshot,
    payloadSha256,
    note: input.reason,
    confirmedById: input.actorId,
    isCreditNote: true,
    creditNoteForId: input.invoiceId,
    lines: creditLines,
    taxSummaries: creditTaxSummaries,
    sequence: { documentType: "INVOICE", fiscalYear, lastNumber: issued.sequence },
  });

  // ④ 締めを差し戻す（再発行できる状態へ / DECISIONS #126）。
  const periodReopened = await reopenPeriodFor(env, ctx, input.invoiceId);

  // ⑥ 赤伝の PDF と送付。**元の請求書には触らない。**
  await enqueueInvoicePdf(env, ctx, {
    invoiceId: creditNoteId,
    sealImageKey: taxProfile.sealImageKey,
  });
  await enqueueInvoiceDelivery(env, ctx, { invoiceId: creditNoteId, sentById: input.actorId });

  return {
    kind: "CORRECTED",
    creditNoteId,
    creditNoteDocumentNo: issued.documentNumber,
    periodReopened,
  };
}

/**
 * その請求書を出した締めを差し戻す。
 *
 * **見つからなくても失敗にしない。** 締めに紐づかない請求書
 * （将来の前受金・手動発行）がありうる。差し戻せなかったことは
 * 結果に載せ、呼び出し側が画面へ出す。
 */
async function reopenPeriodFor(
  env: Env,
  ctx: TenantContext,
  invoiceId: string,
): Promise<boolean> {
  const periods = await listBillingPeriods(env, ctx, { status: ["INVOICED"] });
  const period = periods.find((row) => row.invoiceId === invoiceId);
  if (period === undefined) return false;

  const transition = evaluateBillingPeriodTransition(period.status, "REOPEN");
  if (!transition.allowed) return false;

  const changed = await updateBillingPeriodStatus(
    env,
    ctx,
    period.id,
    // **`invoiceId` を外す。** 残したままだと `issueInvoice()` が
    // 「発行済み」と判断して再発行できない。
    { status: transition.next, invoiceId: null },
    period.status,
  );
  return changed > 0;
}
