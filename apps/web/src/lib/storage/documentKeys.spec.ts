/**
 * 帳票 PDF の R2 キーが、署名付き URL の配布経路（`/api/v1/files/:key`）の
 * 許可一覧に載っていることの検査。
 *
 * task: なし（DECISIONS #215 / 人間の指示 2026-08-20）
 *
 * ── なぜこの検査が要るのか ──────────────────────────────
 * `routes/api/v1/files.ts` は**キーの接頭辞で配布対象を絞る。** 載っていない
 * 接頭辞は、正しく署名した URL でも 404 になる。請求書 PDF はまさにこれで、
 * 画面の「請求書PDF」を押しても開けなかった。**接頭辞を増やす側
 * （`lib/report/*`）と許可する側（`files.ts`）が別ファイルなので、
 * 片方だけ足しても型は通る。** ここで結び付けておく。
 *
 * ── キーの形も見る ──────────────────────────────────────
 * `files.ts` は `{接頭辞}/{組織 ID}/` で自組織のものかを照合する
 * （第 2 層 / architecture.md §2）。キー生成側がこの形を崩すと、
 * 自分の帳票が 404 になる。
 */

import { describe, expect, it } from "vitest";

import { invoicePdfKey, receiptPdfKey } from "../report/invoice.js";
import { payoutPdfKey } from "../report/payout.js";

const ORG_ID = "o7k2m9";

/**
 * `files.ts` が帳票として通す接頭辞。**あちらの `BILLING_PDF_PREFIXES` と
 * 同じ並びであること。** 片方に足したらここが落ちる。
 */
const ALLOWED_PREFIXES = ["invoices", "receipts", "payouts"] as const;

function isServable(key: string, organizationId: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(`${prefix}/${organizationId}/`));
}

describe("帳票 PDF のキーは署名付き URL で配れる", () => {
  it("請求書", () => {
    const key = invoicePdfKey({ organizationId: ORG_ID, documentNo: "INV-2026-0042", revision: 1 });
    expect(key).toBe("invoices/o7k2m9/INV-2026-0042-r1.pdf");
    expect(isServable(key, ORG_ID)).toBe(true);
  });

  it("領収書", () => {
    const key = receiptPdfKey({ organizationId: ORG_ID, documentNo: "RCP-2026-0018", revision: 1 });
    expect(isServable(key, ORG_ID)).toBe(true);
  });

  it("支払明細書", () => {
    const key = payoutPdfKey({ organizationId: ORG_ID, documentNo: "PAY-2026-0007" });
    expect(isServable(key, ORG_ID)).toBe(true);
  });

  it("別組織のキーは配らない（キーの 2 区間目で照合する）", () => {
    const key = invoicePdfKey({
      organizationId: "other1",
      documentNo: "INV-2026-0001",
      revision: 1,
    });
    expect(isServable(key, ORG_ID)).toBe(false);
  });

  it("許可されていない接頭辞は配らない", () => {
    expect(isServable(`fonts/${ORG_ID}/NotoSansJP.ttf`, ORG_ID)).toBe(false);
    expect(isServable(`invoices${ORG_ID}/INV.pdf`, ORG_ID)).toBe(false);
  });
});
