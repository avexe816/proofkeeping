/**
 * 領収書 PDF のテンプレートの検査（PK-SPEC-P5 §8.2）。
 *
 * task:  docs/tasks/P5-08.md
 * ルール: .claude/rules/billing.md §3（印紙）
 *
 * ── いちばん大事な検査 ──────────────────────────────────
 * P5-08 の完了条件そのもの。
 *   ① **印紙貼付欄が無い**
 *   ② 電子発行の注記が**固定表示**される（payload から差し替えられない）
 */

import type { ReceiptPayload } from "@pk/billing";
import { describe, expect, it } from "vitest";

import type { InvoiceFont } from "./invoice.js";
import { RECEIPT_LABELS } from "./labels.js";
import { buildReceiptDocument } from "./receipt.js";
import { renderReceiptPdf } from "./render.js";

const LATIN: InvoiceFont = { kind: "BUILT_IN_LATIN" };

function payload(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    documentNo: "RCP-2026-0018",
    issueDate: "2026-10-28",
    receivedAmount: 1113860,
    receivedDate: "2026-10-28",
    paymentMethod: "銀行振込",
    purposeText: "清掃業務委託料として（2026年9月分）",
    invoiceDocumentNo: "INV-2026-0042",
    isQualifiedInvoice: true,
    issuer: {
      legalName: "Sample Cleaning KK",
      registrationNo: "T1234567890123",
      postalCode: "1500001",
      address: "Shibuya Tokyo",
      tel: "03-0000-0000",
    },
    counterparty: {
      legalName: "Sample Hotel KK",
      postalCode: "1000001",
      address1: "Chiyoda Tokyo",
      address2: null,
      department: null,
      contactName: null,
    },
    taxSummaries: [
      {
        taxRate: 10,
        isReducedRate: false,
        subtotalAmount: 1012600,
        taxAmount: 101260,
        totalAmount: 1113860,
      },
    ],
    ...overrides,
  };
}

function flatten(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") return [];
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return [node, ...list.flatMap(flatten)];
}

function texts(node: unknown): string[] {
  return flatten(node).flatMap((element) => {
    const children = (element as { props?: { children?: unknown } }).props?.children;
    return typeof children === "string" ? [children] : [];
  });
}

function joined(input: ReceiptPayload): string {
  return texts(buildReceiptDocument(input, LATIN)).join("\n");
}

describe("印紙（billing.md §3 MUST / P5-08 の完了条件）", () => {
  it("**印紙貼付欄が無い**", () => {
    // **注記そのものを除いて見る。** §8.2 が定める注記は
    // 「収入印紙の貼付を要しません」と書くので、語の有無だけでは
    // 欄の有無を判定できない。注記を外した残りに印紙が出ないこと。
    const output = joined(payload())
      .split("\n")
      .filter((line) => line !== RECEIPT_LABELS.electronicNotice)
      .join("\n");
    expect(output).not.toContain("収入印紙");
    expect(output).not.toContain("印紙");
    expect(output).not.toContain("貼付");
  });

  it("「印紙」という語が出るのは電子発行の注記の中だけ", () => {
    const output = joined(payload());
    const lines = output.split("\n").filter((line) => line.includes("印紙"));
    expect(lines).toEqual([RECEIPT_LABELS.electronicNotice]);
  });

  it("電子発行の注記が**固定表示**される", () => {
    expect(joined(payload())).toContain(RECEIPT_LABELS.electronicNotice);
  });

  it("5 万円超でも注記は同じ（金額で出し分けない）", () => {
    expect(joined(payload({ receivedAmount: 100 }))).toContain(RECEIPT_LABELS.electronicNotice);
    expect(joined(payload({ receivedAmount: 9999999 }))).toContain(
      RECEIPT_LABELS.electronicNotice,
    );
  });

  it("**注記を payload から差し替えられない**", () => {
    // 但し書きに別の文を入れても注記は定数のまま出る。
    const output = joined(payload({ purposeText: "収入印紙を貼付のこと" }));
    expect(output).toContain(RECEIPT_LABELS.electronicNotice);
  });
});

describe("§8.2 の記載事項", () => {
  it("表題・文書番号・発行日", () => {
    const output = joined(payload());
    expect(output).toContain(RECEIPT_LABELS.title);
    expect(output).toContain("RCP-2026-0018");
    expect(output).toContain("2026年10月28日");
  });

  it("宛先に敬称が付く", () => {
    expect(joined(payload())).toContain(`Sample Hotel KK ${RECEIPT_LABELS.honorific}`);
  });

  it("金額（桁区切り＋ハイフン）", () => {
    expect(joined(payload())).toContain("¥1,113,860 -");
  });

  it("但し書きと領収の文言", () => {
    const output = joined(payload());
    expect(output).toContain("清掃業務委託料として（2026年9月分）");
    expect(output).toContain(RECEIPT_LABELS.received);
  });

  it("税率ごとの内訳", () => {
    const output = joined(payload());
    expect(output).toContain("¥1,012,600");
    expect(output).toContain("¥101,260");
  });

  it("支払方法・入金日・対象請求書", () => {
    const output = joined(payload());
    expect(output).toContain("銀行振込");
    expect(output).toContain("INV-2026-0042");
  });

  it("**請求書に紐づかない領収書では対象請求書の行を出さない**（前受金 / §2.6）", () => {
    const output = joined(payload({ invoiceDocumentNo: null }));
    expect(output).not.toContain(RECEIPT_LABELS.targetInvoice);
  });

  it("発行元と登録番号", () => {
    const output = joined(payload());
    expect(output).toContain("Sample Cleaning KK");
    expect(output).toContain(`${RECEIPT_LABELS.registrationNo} T1234567890123`);
  });

  it("登録番号が未設定なら空の行を出さず、但し書きを出す", () => {
    const output = joined(
      payload({
        isQualifiedInvoice: false,
        issuer: { ...payload().issuer, registrationNo: null },
      }),
    );
    expect(output).not.toContain(RECEIPT_LABELS.registrationNo);
    expect(output).toContain(RECEIPT_LABELS.notQualified);
  });
});

describe("角印", () => {
  it("渡せば画像が載る", () => {
    const document = buildReceiptDocument(payload(), LATIN, {
      dataUrl: "data:image/png;base64,AA",
    });
    const sources = flatten(document).flatMap((element) => {
      const src = (element as { props?: { src?: unknown } }).props?.src;
      return typeof src === "string" ? [src] : [];
    });
    expect(sources).toContain("data:image/png;base64,AA");
  });

  it("未設定なら枠ごと出さない", () => {
    const document = buildReceiptDocument(payload(), LATIN, null);
    const sources = flatten(document).flatMap((element) => {
      const src = (element as { props?: { src?: unknown } }).props?.src;
      return typeof src === "string" ? [src] : [];
    });
    expect(sources).toHaveLength(0);
  });
});

describe("描画", () => {
  it("PDF のバイト列になる", async () => {
    const bytes = await renderReceiptPdf(payload(), LATIN);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect([...bytes.subarray(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("内訳が 0 行でも描ける", async () => {
    const bytes = await renderReceiptPdf(payload({ taxSummaries: [] }), LATIN);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
