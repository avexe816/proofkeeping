/**
 * 支払明細書 PDF のテンプレートの検査（docs/PK-SPEC-PAY.md §3.2）。
 *
 * task:  docs/tasks/P5-18.md（作業ログ「未達（追送）」）
 * ルール: PAY §0.2（控除を作らない）/ security.md §5
 *
 * ── いちばん大事な検査 ──────────────────────────────────
 *   ① **控除の欄が無い**（社会保険・源泉徴収の語が出ない）
 *   ② 仕入明細書方式の注記は **CONTRACTOR のときだけ固定表示**
 *   ③ 合計は payload の値そのまま（テンプレートが足し直さない）
 */

import type { PayoutStatementPayload } from "@pk/billing";
import { describe, expect, it } from "vitest";

import type { InvoiceFont } from "./invoice.js";
import { PAYOUT_LABELS } from "./labels.js";
import { buildPayoutStatementDocument } from "./payoutStatement.js";
import { renderPayoutStatementPdf } from "./render.js";

const LATIN: InvoiceFont = { kind: "BUILT_IN_LATIN" };

function payload(overrides: Partial<PayoutStatementPayload> = {}): PayoutStatementPayload {
  return {
    documentNo: "PAY-2026-0007",
    issueDate: "2026-09-05",
    periodFrom: "2026-08-01",
    periodTo: "2026-08-31",
    payer: {
      legalName: "Sample Cleaning KK",
      registrationNo: "T1234567890123",
      postalCode: "1500001",
      address: "Shibuya Tokyo",
      tel: "03-0000-0000",
    },
    payee: {
      displayName: "Sample Staff",
      staffNumber: "1024",
      registrationNo: "T9876543210987",
    },
    isContractor: true,
    lines: [
      {
        lineNo: 1,
        description: "Hotel A CHECKOUT",
        quantity: 42,
        unitType: "PER_TASK",
        unitPrice: 3000,
        amount: 126000,
      },
      {
        lineNo: 2,
        description: "Hotel B DEEP",
        quantity: 300,
        unitType: "HOURLY",
        unitPrice: 1400,
        amount: 7000,
      },
      {
        lineNo: 1001,
        description: "Kurikaeshi seisou",
        quantity: 1,
        unitType: null,
        unitPrice: -2000,
        amount: -2000,
      },
    ],
    totalAmount: 131000,
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

function joined(input: PayoutStatementPayload): string {
  return texts(buildPayoutStatementDocument(input, LATIN)).join("\n");
}

describe("控除の欄が無い（PAY §0.2 MUST）", () => {
  it("社会保険・源泉徴収・年末調整・控除の語が出ない", () => {
    const output = joined(payload());
    for (const word of ["社会保険", "源泉", "年末調整", "控除", "給与計算"]) {
      expect(output).not.toContain(word);
    }
  });

  it("合計は payload の値そのまま（足し直さない）", () => {
    // 明細の和（131,000）とわざと食い違う合計を渡す。**紙には渡した値が出る。**
    // 確定時に固定された `totalAmount` が正で、テンプレートは計算しない。
    const output = joined(payload({ totalAmount: 999 }));
    expect(output).toContain("¥999");
    expect(output).not.toContain("¥131,000");
  });
});

describe("仕入明細書方式（PAY §3.2）", () => {
  it("CONTRACTOR なら注記 2 本と受領者の登録番号が出る", () => {
    const output = joined(payload());
    expect(output).toContain(PAYOUT_LABELS.contractorNotice);
    expect(output).toContain(PAYOUT_LABELS.contractorTaxNote);
    expect(output).toContain(`${PAYOUT_LABELS.payeeRegistrationNo} T9876543210987`);
  });

  it("雇用スタッフ（isContractor=false）には出ない", () => {
    const output = joined(payload({ isContractor: false }));
    expect(output).not.toContain(PAYOUT_LABELS.contractorNotice);
    expect(output).not.toContain(PAYOUT_LABELS.contractorTaxNote);
    expect(output).not.toContain("T9876543210987");
  });

  it("CONTRACTOR でも登録番号が未登録なら行を出さない", () => {
    const output = joined(
      payload({ payee: { ...payload().payee, registrationNo: null } }),
    );
    expect(output).not.toContain("T9876543210987");
    // 支払者側の登録番号は変わらず出る。
    expect(output).toContain("T1234567890123");
  });

  it("電子発行の注記は常に出る", () => {
    expect(joined(payload())).toContain(PAYOUT_LABELS.electronicNotice);
    expect(joined(payload({ isContractor: false }))).toContain(PAYOUT_LABELS.electronicNotice);
  });
});

describe("記載事項", () => {
  it("表題・文書番号・発行日・対象期間", () => {
    const output = joined(payload());
    expect(output).toContain(PAYOUT_LABELS.title);
    expect(output).toContain("PAY-2026-0007");
    expect(output).toContain("2026年9月5日");
    expect(output).toContain("2026年8月1日");
    expect(output).toContain("2026年8月31日");
  });

  it("宛先（表示名＋スタッフ番号）と敬称", () => {
    const output = joined(payload());
    expect(output).toContain(`Sample Staff ${PAYOUT_LABELS.honorific}`);
    expect(output).toContain(`${PAYOUT_LABELS.staffNumber} 1024`);
  });

  it("明細（数量・単位・単価・金額）と単位の訳", () => {
    const output = joined(payload());
    expect(output).toContain("42");
    expect(output).toContain(PAYOUT_LABELS.unitPerTask);
    expect(output).toContain(PAYOUT_LABELS.unitHourly);
    // 調整行（unitType=null）は「式」。
    expect(output).toContain(PAYOUT_LABELS.unitLump);
    expect(output).toContain("¥126,000");
  });

  it("マイナスの調整行（赤伝）が `-¥` で出る", () => {
    expect(joined(payload())).toContain("-¥2,000");
  });

  it("支払者と登録番号", () => {
    const output = joined(payload());
    expect(output).toContain("Sample Cleaning KK");
    expect(output).toContain(`${PAYOUT_LABELS.registrationNo} T1234567890123`);
  });

  it("明細 0 行でも「該当なし」で組める", () => {
    const output = joined(payload({ lines: [] }));
    expect(output).toContain(PAYOUT_LABELS.none);
  });
});

describe("描画", () => {
  it("PDF のバイト列になる", async () => {
    const bytes = await renderPayoutStatementPdf(payload(), LATIN);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect([...bytes.subarray(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});
