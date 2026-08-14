/**
 * 請求書 PDF のテンプレートの検査（PK-SPEC-P5 §8.1）。
 *
 * task:  docs/tasks/P5-06.md
 * ルール: .claude/rules/billing.md §1（適格請求書の 6 要件）・§3（印紙）
 *
 * ── CI に和文フォントを置いていない ─────────────────────
 * `BUILT_IN_LATIN`（Helvetica）で描画する（`auditReport.spec.ts` と同じ）。
 *
 * ── いちばん大事な検査 ──────────────────────────────────
 * §1.1 MUST の 6 要件が**すべて**出ること。1 つでも欠けた請求書は
 * 適格請求書にならない。要件ごとに 1 件ずつ置いてある。
 */

import type { InvoicePayload } from "@pk/billing";
import { describe, expect, it } from "vitest";

import { buildInvoiceDocument, type InvoiceFont } from "./invoice.js";
import { INVOICE_LABELS } from "./labels.js";
import { renderInvoicePdf } from "./render.js";

const LATIN: InvoiceFont = { kind: "BUILT_IN_LATIN" };

function payload(overrides: Partial<InvoicePayload> = {}): InvoicePayload {
  return {
    documentNo: "INV-2026-0042",
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    periodFrom: "2026-09-01",
    periodTo: "2026-09-30",
    isQualifiedInvoice: true,
    isCreditNote: false,
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
      department: "Accounting",
      contactName: "Yamada",
    },
    lines: [
      {
        lineNo: 1,
        description: "Sample Hotel Tokyo / Checkout / Single",
        serviceDateFrom: "2026-09-01",
        serviceDateTo: "2026-09-30",
        quantity: 180,
        unit: "室",
        unitPrice: 3200,
        amount: 576000,
        taxRate: 10,
        isReducedRate: false,
      },
      {
        lineNo: 2,
        description: "Sample Hotel Tokyo / Stayover",
        serviceDateFrom: "2026-09-01",
        serviceDateTo: "2026-09-30",
        quantity: 42,
        unit: "室",
        unitPrice: 1800,
        amount: 75600,
        taxRate: 10,
        isReducedRate: false,
      },
    ],
    taxSummaries: [
      {
        taxRate: 10,
        isReducedRate: false,
        subtotalAmount: 651600,
        taxAmount: 65160,
        totalAmount: 716760,
      },
    ],
    subtotalAmount: 651600,
    taxAmount: 65160,
    totalAmount: 716760,
    bankAccountText: null,
    note: null,
    ...overrides,
  };
}

/** 描画された要素を平坦に集める。 */
function flatten(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") return [];
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return [node, ...list.flatMap(flatten)];
}

/** 描画された要素に含まれる文字列。 */
function texts(node: unknown): string[] {
  return flatten(node).flatMap((element) => {
    const children = (element as { props?: { children?: unknown } }).props?.children;
    return typeof children === "string" ? [children] : [];
  });
}

/** 全文を 1 本につないだもの（含まれるかだけ見たいとき）。 */
function joined(input: InvoicePayload, font: InvoiceFont = LATIN): string {
  return texts(buildInvoiceDocument(input, font)).join("\n");
}

describe("適格請求書の 6 要件（§1.1 MUST）", () => {
  it("1. 発行事業者の名称と登録番号", () => {
    const output = joined(payload());
    expect(output).toContain("Sample Cleaning KK");
    expect(output).toContain(`${INVOICE_LABELS.registrationNo} T1234567890123`);
  });

  it("2. 取引年月日（発行日と対象期間）", () => {
    const output = joined(payload());
    expect(output).toContain("2026年10月1日");
    expect(output).toContain("2026年9月1日");
    expect(output).toContain("2026年9月30日");
  });

  it("3. 取引内容", () => {
    const output = joined(payload());
    expect(output).toContain("Sample Hotel Tokyo / Checkout / Single");
    expect(output).toContain("Sample Hotel Tokyo / Stayover");
  });

  it("3. 軽減税率対象なら明示する", () => {
    const output = joined(
      payload({
        lines: [
          {
            lineNo: 1,
            description: "Reduced item",
            serviceDateFrom: null,
            serviceDateTo: null,
            quantity: 1,
            unit: "式",
            unitPrice: 1000,
            amount: 1000,
            taxRate: 8,
            isReducedRate: true,
          },
        ],
      }),
    );
    expect(output).toContain(`8%（${INVOICE_LABELS.reducedRate}）`);
  });

  it("4. 税率ごとに区分した対価の合計額と適用税率", () => {
    const output = joined(payload());
    expect(output).toContain("10%");
    expect(output).toContain("¥651,600");
  });

  it("5. 税率ごとに区分した消費税額等", () => {
    const output = joined(payload());
    expect(output).toContain("¥65,160");
  });

  it("6. 交付を受ける事業者の名称", () => {
    const output = joined(payload());
    expect(output).toContain(`Sample Hotel KK ${INVOICE_LABELS.honorific}`);
  });

  it("税率が 2 つあれば区分が 2 行出る", () => {
    const output = joined(
      payload({
        taxSummaries: [
          {
            taxRate: 10,
            isReducedRate: false,
            subtotalAmount: 100000,
            taxAmount: 10000,
            totalAmount: 110000,
          },
          {
            taxRate: 8,
            isReducedRate: true,
            subtotalAmount: 50000,
            taxAmount: 4000,
            totalAmount: 54000,
          },
        ],
      }),
    );
    expect(output).toContain("¥10,000");
    expect(output).toContain("¥4,000");
  });
});

describe("登録番号が未設定のとき（§1.1 MUST）", () => {
  const unqualified = payload({
    isQualifiedInvoice: false,
    issuer: { ...payload().issuer, registrationNo: null },
  });

  it("「適格請求書ではありません」が出る", () => {
    expect(joined(unqualified)).toContain(INVOICE_LABELS.notQualified);
  });

  it("空の「登録番号」行を出さない", () => {
    expect(joined(unqualified)).not.toContain(INVOICE_LABELS.registrationNo);
  });

  it("適格なら但し書きは出ない", () => {
    expect(joined(payload())).not.toContain(INVOICE_LABELS.notQualified);
  });

  it("**但し書きを payload から差し替えられない**", () => {
    // `notQualified` は定数から読む。payload に文言を持つ経路が無いことを、
    // 備考へ別の文を入れても但し書きが残ることで示す。
    const output = joined(payload({ isQualifiedInvoice: false, note: "書き換えた文言" }));
    expect(output).toContain(INVOICE_LABELS.notQualified);
  });
});

describe("角印（§8.1）", () => {
  it("渡せば画像が載る", () => {
    const document = buildInvoiceDocument(payload(), LATIN, { dataUrl: "data:image/png;base64,AA" });
    const sources = flatten(document).flatMap((element) => {
      const src = (element as { props?: { src?: unknown } }).props?.src;
      return typeof src === "string" ? [src] : [];
    });
    expect(sources).toContain("data:image/png;base64,AA");
  });

  it("未設定なら枠ごと出さない", () => {
    const document = buildInvoiceDocument(payload(), LATIN, null);
    const sources = flatten(document).flatMap((element) => {
      const src = (element as { props?: { src?: unknown } }).props?.src;
      return typeof src === "string" ? [src] : [];
    });
    expect(sources).toHaveLength(0);
  });
});

describe("作ってはいけない表示", () => {
  it("印紙貼付欄が無い（billing.md §3）", () => {
    const output = joined(payload());
    expect(output).not.toContain("収入印紙");
    expect(output).not.toContain("印紙");
  });

  it("振込先が未設定なら節ごと出さない（空欄の枠を載せない）", () => {
    expect(joined(payload())).not.toContain(INVOICE_LABELS.bankAccount);
  });

  it("振込先があれば出る", () => {
    expect(joined(payload({ bankAccountText: "Sample Bank 1234567" }))).toContain(
      INVOICE_LABELS.bankAccount,
    );
  });
});

describe("金額の表示", () => {
  it("桁区切りを入れる", () => {
    expect(joined(payload())).toContain("¥716,760");
  });

  it("赤伝は負の金額を `-¥` で出し、表題が変わる（§5）", () => {
    const output = joined(
      payload({
        isCreditNote: true,
        totalAmount: -716760,
        subtotalAmount: -651600,
        taxAmount: -65160,
      }),
    );
    expect(output).toContain("-¥716,760");
    expect(output).toContain(INVOICE_LABELS.creditNoteTitle);
  });

  it("数量が整数なら小数点を出さない", () => {
    expect(joined(payload())).toContain("180");
    expect(joined(payload())).not.toContain("180.0");
  });

  it("**テンプレートが合計を計算し直さない**", () => {
    // 明細の和と合わない合計を渡しても、payload の値がそのまま出る。
    // 計算は発行時（§4.1 の ③〜⑥）に済んでおり、紙はその写し。
    expect(joined(payload({ totalAmount: 999999 }))).toContain("¥999,999");
  });

  it("明細が 0 行でも落ちない", () => {
    expect(joined(payload({ lines: [] }))).toContain(INVOICE_LABELS.none);
  });
});

describe("描画", () => {
  it("PDF のバイト列になる", async () => {
    const bytes = await renderInvoicePdf(payload(), LATIN);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // PDF のマジックナンバー（`%PDF`）。
    expect([...bytes.subarray(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("明細が 0 行でも描ける", async () => {
    const bytes = await renderInvoicePdf(payload({ lines: [] }), LATIN);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
