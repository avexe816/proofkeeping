/**
 * 請求書 PDF の配線（P5-06 / PK-SPEC-P5 §8.1・§8.3）。
 *
 * ルール: .claude/rules/testing.md §4（冪等）/ billing.md §2（電帳法）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - メッセージの形（`pdf-generation` に 3 種類が載る）
 *   - **R2 のキーが `(組織, 文書番号, 版)` で決まる**（冪等）
 *   - **版が違えば別のキー**（元の PDF を上書きしない / billing.md §2）
 *   - スナップショットの読み取りが欠けた項目で落ちないこと
 */

import { describe, expect, it } from "vitest";

import { isAuditReportMessage } from "./auditReport.js";
import { isDailyReportMessage } from "./dailyReport.js";
import {
  isInvoicePdfMessage,
  isPayoutPdfMessage,
  type InvoicePdfMessage,
  type PayoutPdfMessage,
} from "./invoicePdf.js";
import {
  invoicePdfFileName,
  invoicePdfKey,
  readCounterpartySnapshot,
  readIssuerSnapshot,
} from "../lib/report/invoice.js";
import { payoutPdfKey } from "../lib/report/payout.js";

const MESSAGE: InvoicePdfMessage = {
  kind: "INVOICE_PDF",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  invoiceId: "a1b2c3__inv_01JBXQ3ZK8N4P2VYR6",
  sealImageKey: "seals/org_test_alpha/seal.png",
  requestedAtMs: Date.UTC(2026, 9, 1, 0, 0, 0),
};

describe("isInvoicePdfMessage", () => {
  it("正しい形を通す", () => {
    expect(isInvoicePdfMessage(MESSAGE)).toBe(true);
  });

  it("角印が `null` でも通す（角印は必須ではない）", () => {
    expect(isInvoicePdfMessage({ ...MESSAGE, sealImageKey: null })).toBe(true);
  });

  it("`kind` が違えば偽", () => {
    expect(isInvoicePdfMessage({ ...MESSAGE, kind: "DAILY_REPORT" })).toBe(false);
  });

  it("`invoiceId` が無ければ偽", () => {
    const rest: Record<string, unknown> = { ...MESSAGE };
    delete rest["invoiceId"];
    expect(isInvoicePdfMessage(rest)).toBe(false);
  });

  it("角印のキーが数値なら偽", () => {
    expect(isInvoicePdfMessage({ ...MESSAGE, sealImageKey: 1 })).toBe(false);
  });

  it("`null` / 文字列は偽", () => {
    expect(isInvoicePdfMessage(null)).toBe(false);
    expect(isInvoicePdfMessage("INVOICE_PDF")).toBe(false);
  });

  it("**他の 2 種類と取り違えない**（1 本のキューに 3 種類が載る）", () => {
    expect(isDailyReportMessage(MESSAGE)).toBe(false);
    expect(isAuditReportMessage(MESSAGE)).toBe(false);
    expect(isInvoicePdfMessage(MESSAGE)).toBe(true);
  });
});

describe("invoicePdfKey", () => {
  const base = { organizationId: "org_test_alpha", documentNo: "INV-2026-0042", revision: 1 };

  it("組織・文書番号・版で決まる（同じ入力なら同じキー / 冪等）", () => {
    expect(invoicePdfKey(base)).toBe(invoicePdfKey({ ...base }));
    expect(invoicePdfKey(base)).toBe("invoices/org_test_alpha/INV-2026-0042-r1.pdf");
  });

  it("**版が違えば別のキー**（元の PDF を上書きしない / billing.md §2）", () => {
    expect(invoicePdfKey({ ...base, revision: 2 })).not.toBe(invoicePdfKey(base));
  });

  it("組織が違えば別のキー", () => {
    expect(invoicePdfKey({ ...base, organizationId: "org_test_beta" })).not.toBe(
      invoicePdfKey(base),
    );
  });

  it("日報・角印の接頭辞と混ざらない", () => {
    expect(invoicePdfKey(base).startsWith("invoices/")).toBe(true);
  });

  it("ファイル名は文書番号そのもの（取引先が見る名前）", () => {
    expect(invoicePdfFileName("INV-2026-0042")).toBe("INV-2026-0042.pdf");
  });
});

const PAYOUT_MESSAGE: PayoutPdfMessage = {
  kind: "PAYOUT_PDF",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  payoutPeriodId: "a1b2c3__pout_01JBXQ3ZK8N4P2VYR6",
  sealImageKey: null,
  requestedAtMs: Date.UTC(2026, 9, 1, 0, 0, 0),
};

describe("isPayoutPdfMessage（P5-18 追送）", () => {
  it("正しい形を通す", () => {
    expect(isPayoutPdfMessage(PAYOUT_MESSAGE)).toBe(true);
  });

  it("`payoutPeriodId` が無ければ偽", () => {
    const rest: Record<string, unknown> = { ...PAYOUT_MESSAGE };
    delete rest["payoutPeriodId"];
    expect(isPayoutPdfMessage(rest)).toBe(false);
  });

  it("**他の種類と取り違えない**（1 本のキューに載る）", () => {
    expect(isInvoicePdfMessage(PAYOUT_MESSAGE)).toBe(false);
    expect(isDailyReportMessage(PAYOUT_MESSAGE)).toBe(false);
    expect(isPayoutPdfMessage(MESSAGE)).toBe(false);
  });
});

describe("payoutPdfKey", () => {
  const base = { organizationId: "org_test_alpha", documentNo: "PAY-2026-0007" };

  it("組織・文書番号で決まる（同じ入力なら同じキー / 冪等）", () => {
    expect(payoutPdfKey(base)).toBe(payoutPdfKey({ ...base }));
    expect(payoutPdfKey(base)).toBe("payouts/org_test_alpha/PAY-2026-0007.pdf");
  });

  it("組織・番号が違えば別のキー", () => {
    expect(payoutPdfKey({ ...base, organizationId: "org_test_beta" })).not.toBe(
      payoutPdfKey(base),
    );
    expect(payoutPdfKey({ ...base, documentNo: "PAY-2026-0008" })).not.toBe(payoutPdfKey(base));
  });

  it("請求書・領収書の接頭辞と混ざらない", () => {
    expect(payoutPdfKey(base).startsWith("payouts/")).toBe(true);
  });
});

describe("スナップショットの読み取り", () => {
  it("発行元を読む", () => {
    expect(
      readIssuerSnapshot({
        legalName: "Sample Cleaning KK",
        registrationNo: "T1234567890123",
        postalCode: "1500001",
        address: "Shibuya",
        tel: "03-0000-0000",
      }),
    ).toEqual({
      legalName: "Sample Cleaning KK",
      registrationNo: "T1234567890123",
      postalCode: "1500001",
      address: "Shibuya",
      tel: "03-0000-0000",
    });
  });

  it("税務プロファイルの列名（`invoiceRegistrationNumber`）でも読める", () => {
    const issuer = readIssuerSnapshot({
      legalName: "Sample Cleaning KK",
      invoiceRegistrationNumber: "T1234567890123",
    });
    expect(issuer?.registrationNo).toBe("T1234567890123");
  });

  it("欠けた項目は `null`（落とさない）", () => {
    expect(readIssuerSnapshot({ legalName: "Sample Cleaning KK" })).toEqual({
      legalName: "Sample Cleaning KK",
      registrationNo: null,
      postalCode: null,
      address: null,
      tel: null,
    });
  });

  it("空文字は `null` にする（空の行を紙に出さない）", () => {
    const issuer = readIssuerSnapshot({ legalName: "Sample Cleaning KK", tel: "" });
    expect(issuer?.tel).toBeNull();
  });

  it("**名称が無ければ `null`**（発行事業者の名前が無い請求書は出せない）", () => {
    expect(readIssuerSnapshot({})).toBeNull();
    expect(readIssuerSnapshot({ legalName: "" })).toBeNull();
    expect(readIssuerSnapshot({ legalName: 42 })).toBeNull();
  });

  it("交付を受ける事業者も同じ（名称は必須）", () => {
    expect(readCounterpartySnapshot({ legalName: "Sample Hotel KK" })).toEqual({
      legalName: "Sample Hotel KK",
      postalCode: null,
      address1: null,
      address2: null,
      department: null,
      contactName: null,
    });
    expect(readCounterpartySnapshot({})).toBeNull();
  });
});
