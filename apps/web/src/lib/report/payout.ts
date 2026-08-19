/**
 * 支払明細書 PDF の材料集め（docs/PK-SPEC-PAY.md §3.2 / P5-18 追送）。
 *
 * task:  docs/tasks/P5-18.md（作業ログ「未達（追送）」）
 * ルール: .claude/rules/billing.md §2 / security.md §5
 *
 * ── ここは読むだけ ──────────────────────────────────────
 * 確定済み（CONFIRMED）の支払期間から `PayoutStatementPayload` を組む。
 * **合計はここで取り直さない**（`payoutPeriod.totalAmount` は確定時に
 * 固定された値。PAY §1.3）。
 *
 * ── スナップショット列を持たない ────────────────────────
 * 請求書と違い、`payoutPeriod` に発行元・宛先のスナップショット列は
 * 無い。**PDF は確定直後に 1 回だけ生成され、再生成の口が無い**
 * （regenerate API を作らない / PAY §3.2）ため、生成の瞬間に読んだ
 * マスタが事実上のスナップショットになる。再生成の口を足すときは、
 * 先にスナップショット列を足すこと（billing.md §6 と同じ理由）。
 *
 * ── 呼ぶのは Queue コンシューマ ─────────────────────────
 * リクエストハンドラから呼ばない（architecture.md §5）。
 */

import type { PayoutStatementLine, PayoutStatementPayload } from "@pk/billing";
import {
  findPayoutPeriodById,
  findTaxProfile,
  listOrgMembers,
  listPayoutLines,
  listStaffPayProfiles,
  type Env,
  type TenantContext,
} from "@pk/db";

/** `DOCUMENTS` バケットの支払明細書の接頭辞。**請求書・領収書とは別。** */
export const PAYOUT_PDF_PREFIX = "payouts";

/**
 * 支払明細書 PDF の R2 キー。
 *
 * **版（revision）を持たない。** 確定後の訂正は赤伝方式（次の期間に
 * マイナスの調整行 / PAY §3.1）で**別の文書番号**になり、同じ番号の
 * PDF を作り直す口が無い。番号が変われば別のキーになる。
 */
export function payoutPdfKey(input: { organizationId: string; documentNo: string }): string {
  return `${PAYOUT_PDF_PREFIX}/${input.organizationId}/${input.documentNo}.pdf`;
}

/** 現地時刻の暦日（`Asia/Tokyo`）。発行日に使う（`receipts.ts` と同じ）。 */
function dateInJst(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * 支払明細書 1 通ぶんの payload を組む。**組めなければ `null`。**
 *
 * `null` は「再送しても直らない」を意味する（コンシューマが ack する）。
 * CONFIRMED 以外・採番前の期間は対象外（PDF は確定の後工程 / PAY §3.1）。
 */
export async function collectPayoutStatementPayload(
  env: Env,
  ctx: TenantContext,
  payoutPeriodId: string,
): Promise<PayoutStatementPayload | null> {
  const period = await findPayoutPeriodById(env, ctx, payoutPeriodId);
  if (period === undefined) return null;
  if (period.status !== "CONFIRMED" || period.documentNo === null) return null;

  const [taxProfile, members, profiles, lines] = await Promise.all([
    findTaxProfile(env, ctx),
    listOrgMembers(env, ctx),
    listStaffPayProfiles(env, ctx),
    listPayoutLines(env, ctx, payoutPeriodId),
  ]);
  // 税務プロファイルは確定時に検証済み（`confirmPayoutPeriod()`）。
  // ここで無いのは「確定後に消えた」なので、再送しても直らない。
  if (taxProfile === undefined) return null;

  const member = members.find((row) => row.membershipId === period.membershipId);
  if (member === undefined) return null;
  const profile = profiles.find((row) => row.membershipId === period.membershipId);

  const statementLines: PayoutStatementLine[] = lines.map((line) => ({
    lineNo: line.lineNo,
    description: line.description,
    quantity: line.quantity,
    unitType: line.unitType,
    unitPrice: line.unitPrice,
    amount: line.amount,
    // **警告コード（NO_PAY_RULE 等）は紙に載せない**（内部の運用情報）。
  }));

  return {
    documentNo: period.documentNo,
    // 発行日 = 確定日。確定前の期間は上で弾いているが、旧データ保護で
    // 欠けていたら要求時刻に寄せる（日付が空の帳票を出さない）。
    issueDate: dateInJst(period.confirmedAt ?? ctx.now),
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    payer: {
      legalName: taxProfile.legalName,
      registrationNo: taxProfile.invoiceRegistrationNumber,
      postalCode: taxProfile.postalCode,
      address: taxProfile.address,
      tel: taxProfile.tel,
    },
    payee: {
      displayName: member.displayName,
      staffNumber: member.staffNumber,
      registrationNo: profile?.invoiceRegistrationNo ?? null,
    },
    // 支払属性が無いスタッフは雇用扱い（仕入明細書方式の注記を出さない）。
    isContractor: profile?.employmentType === "CONTRACTOR",
    lines: statementLines,
    // **確定時に固定された値。ここで足し直さない**（PAY §1.3）。
    totalAmount: period.totalAmount,
  };
}
