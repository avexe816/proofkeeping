/**
 * 清掃会社プランの組み立てのテスト（P5-15 / PK-SPEC-P5 §7.2）。
 *
 * ── どこで何を押さえているか ────────────────────────────
 *   ① 状態の写像・要対応の判定 …… ここ（純粋関数）
 *   ② 売上と未回収の合計 …… ここ
 *   ③ 組織平均の分子と分母 …… ここ
 *   ④ 時間単価と 85% の判定 …… `format.spec.ts`
 *   ⑤ 権限・契約・全社ビュー …… `routes/api/v1/dashboard.spec.ts`
 *   ⑥ 組織条件が載ること …… `packages/db/.../repositories.spec.ts`
 */

import type { VendorBillingRow, VendorPropertyRow } from "@pk/contracts";
import { describe, expect, it } from "vitest";

import { hourlyRate } from "./format.js";
import {
  averageRateBasis,
  billingStateOfInvoice,
  buildBillingRow,
  needsActionOf,
  sumSales,
} from "./vendor.js";

function billingRow(overrides: Partial<VendorBillingRow> = {}): VendorBillingRow {
  return {
    counterpartyId: "cp-a",
    counterpartyName: "ホテルA運営",
    periodFrom: "2026-09-01",
    periodTo: "2026-09-30",
    amount: 1_113_860,
    isConfirmedAmount: true,
    state: "PAID",
    needsAction: false,
    billingPeriodId: null,
    invoiceId: "inv-a",
    ...overrides,
  };
}

function propertyRow(overrides: Partial<VendorPropertyRow> = {}): VendorPropertyRow {
  return {
    propertyId: "prop-a",
    code: "A",
    name: "ホテルA",
    totalTasks: 0,
    totalMinutes: 0,
    billedAmount: null,
    ...overrides,
  };
}

describe("billingStateOfInvoice", () => {
  it.each([
    ["PAID", "PAID"],
    ["OVERDUE", "OVERDUE"],
    ["VOIDED", "VOIDED"],
    ["SENT", "SENT"],
    ["VIEWED", "SENT"],
    ["CONFIRMED", "ISSUED"],
  ])("%s → %s", (status, expected) => {
    expect(billingStateOfInvoice(status)).toBe(expected);
  });

  it("下書きは「まだ動く数字」として集計中に落とす", () => {
    expect(billingStateOfInvoice("DRAFT")).toBe("AGGREGATING");
  });

  it("一部入金は入金済にしない（OPEN_QUESTIONS #076）", () => {
    expect(billingStateOfInvoice("PARTIALLY_PAID")).not.toBe("PAID");
  });
});

describe("needsActionOf", () => {
  it.each([["REVIEWING"], ["OVERDUE"]] as const)("%s は要対応", (state) => {
    expect(needsActionOf(state)).toBe(true);
  });

  // 集計中に印を付けると、月の途中はほぼ全行が要対応になり印が意味を失う。
  it.each([["AGGREGATING"], ["AGREED"], ["ISSUED"], ["SENT"], ["PAID"], ["VOIDED"]] as const)(
    "%s は要対応にしない",
    (state) => {
      expect(needsActionOf(state)).toBe(false);
    },
  );
});

describe("buildBillingRow", () => {
  it("請求書があれば金額も名前も帳票のものを使う（billing.md §6）", () => {
    const row = buildBillingRow(
      {
        counterpartyId: "cp-a",
        periodFrom: "2026-09-01",
        periodTo: "2026-09-30",
        billingPeriodId: "per-a",
        periodStatus: null,
        invoice: {
          id: "inv-a",
          status: "SENT",
          totalAmount: 842_300,
          counterpartyName: "ホテルB運営（旧名）",
        },
        snapshotTotal: 999_999,
      },
      "ホテルB運営",
    );

    expect(row).toMatchObject({
      amount: 842_300,
      counterpartyName: "ホテルB運営（旧名）",
      isConfirmedAmount: true,
      state: "SENT",
      invoiceId: "inv-a",
    });
  });

  it("請求書が無ければ締めの状態と、最後に見せた写しで埋める", () => {
    const row = buildBillingRow(
      {
        counterpartyId: "cp-c",
        periodFrom: "2026-09-01",
        periodTo: "2026-09-30",
        billingPeriodId: "per-c",
        periodStatus: "REVIEWING",
        invoice: null,
        snapshotTotal: 398_100,
      },
      "ホテルC運営",
    );

    expect(row).toMatchObject({
      amount: 398_100,
      counterpartyName: "ホテルC運営",
      isConfirmedAmount: false,
      state: "REVIEWING",
      needsAction: true,
      invoiceId: null,
      billingPeriodId: "per-c",
    });
  });

  it("誰にも見せていない期間は金額が null（0 円ではない）", () => {
    const row = buildBillingRow(
      {
        counterpartyId: "cp-d",
        periodFrom: "2026-09-01",
        periodTo: "2026-09-30",
        billingPeriodId: "per-d",
        periodStatus: "OPEN",
        invoice: null,
        snapshotTotal: null,
      },
      "ホテルD運営",
    );

    expect(row.amount).toBeNull();
    expect(row.state).toBe("AGGREGATING");
  });
});

describe("sumSales", () => {
  it("§7.2 の見本（入金済 1 件・未入金 2 件）", () => {
    const rows = [
      billingRow({ amount: 1_113_860, state: "PAID" }),
      billingRow({ counterpartyId: "cp-b", amount: 842_300, state: "SENT" }),
      billingRow({ counterpartyId: "cp-c", amount: 398_100, state: "ISSUED" }),
    ];

    expect(sumSales(rows)).toEqual({ salesTotal: 2_354_260, unpaidTotal: 1_240_400 });
  });

  it("確定前の金額を売上に足さない（見せただけの数字は売上ではない）", () => {
    const rows = [
      billingRow({ amount: 1_113_860, state: "PAID" }),
      billingRow({
        counterpartyId: "cp-d",
        amount: 521_400,
        isConfirmedAmount: false,
        state: "AGGREGATING",
        invoiceId: null,
      }),
    ];

    expect(sumSales(rows)).toEqual({ salesTotal: 1_113_860, unpaidTotal: 0 });
  });

  it("取り消した請求書を売上に足さない", () => {
    const rows = [
      billingRow({ amount: 1_113_860, state: "PAID" }),
      billingRow({ counterpartyId: "cp-x", amount: 700_000, state: "VOIDED" }),
    ];

    expect(sumSales(rows)).toEqual({ salesTotal: 1_113_860, unpaidTotal: 0 });
  });

  it("赤伝（負の額）をそのまま足す（訂正後の実額を出す）", () => {
    const rows = [
      billingRow({ amount: 1_113_860, state: "SENT" }),
      billingRow({ counterpartyId: "cp-a2", amount: -113_860, state: "SENT" }),
    ];

    expect(sumSales(rows)).toEqual({ salesTotal: 1_000_000, unpaidTotal: 1_000_000 });
  });

  it("確定した請求書が 1 枚も無ければ null（0 円ではない）", () => {
    expect(sumSales([])).toEqual({ salesTotal: null, unpaidTotal: null });
    expect(
      sumSales([billingRow({ isConfirmedAmount: false, amount: 500, invoiceId: null })]),
    ).toEqual({ salesTotal: null, unpaidTotal: null });
  });
});

describe("averageRateBasis", () => {
  it("全社の請求額 ÷ 全社の実働時間（加重平均になる）", () => {
    const rows = [
      propertyRow({ billedAmount: 1_113_860, totalMinutes: 37_860 }),
      propertyRow({ propertyId: "prop-b", billedAmount: 842_300, totalMinutes: 28_680 }),
      propertyRow({ propertyId: "prop-c", billedAmount: 398_100, totalMinutes: 14_700 }),
    ];

    expect(averageRateBasis(rows)).toEqual({ billedAmount: 2_354_260, totalMinutes: 81_240 });
  });

  it("施設の単価を平均しない（件数の少ない施設が平均を動かさない）", () => {
    const rows = [
      // 1,000 円/h が 100 時間、2,000 円/h が 1 時間。
      propertyRow({ billedAmount: 100_000, totalMinutes: 6000 }),
      propertyRow({ propertyId: "prop-b", billedAmount: 2000, totalMinutes: 60 }),
    ];

    const basis = averageRateBasis(rows);
    // 単純平均なら 1,500 円。加重平均は 1,009 円。
    expect(hourlyRate(basis.billedAmount, basis.totalMinutes)).toBe(1009);
  });

  it("請求額が無い施設は分子にも分母にも入れない", () => {
    const rows = [
      propertyRow({ billedAmount: 100_000, totalMinutes: 6000 }),
      propertyRow({ propertyId: "prop-b", billedAmount: null, totalMinutes: 60_000 }),
    ];

    expect(averageRateBasis(rows)).toEqual({ billedAmount: 100_000, totalMinutes: 6000 });
  });

  it("請求額のある施設が 1 つも無ければ平均を出さない", () => {
    expect(averageRateBasis([propertyRow(), propertyRow({ propertyId: "prop-b" })])).toEqual({
      billedAmount: null,
      totalMinutes: 0,
    });
  });
});
