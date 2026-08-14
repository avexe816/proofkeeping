/**
 * 清掃会社プラン（PK-SPEC-P5 §7.2）。
 *
 * task: docs/tasks/P5-15.md
 *
 * ── §7.1 と形を揃えない ─────────────────────────────────
 * `dashboard.ts` は**ホテル側**の見え方（1 室あたり原価・完了率）で、
 * こちらは**清掃会社側**の見え方（請求額・実働時間・時間単価）。
 * 同じ月・同じ rollup を読むが、並べる列も金額の税区分も違う。
 * 列が似ているからと共有すると、片方の都合でもう片方が壊れる
 * （`dashboard.ts` の同じ注記）。
 *
 * ── 割合と割り算を返さない（§7.1 と同じ）────────────────
 * 時間単価も「請求額 ÷ 実働時間」の割り算で、**サーバーで割らない。**
 * 分子（`billedAmount`）と分母（`totalMinutes`）を整数で返し、画面が
 * 割る（`apps/web/src/lib/dashboard/format.ts`）。85% の判定も同じ。
 *
 * ── 税込と税抜が同じ画面に並ぶ ──────────────────────────
 * **請求状況は税込、施設別収支は税抜。** 前者は帳票そのものの金額
 * （`invoice.totalAmount`）で、取引先に請求した額と 1 円も違ってはならない。
 * 後者は明細の合計（`invoice_line.amount`）で、施設ごとに分けられるのは
 * 明細だけであり、消費税は税率ごとに 1 回だけ端数処理する以上、施設へは
 * 割り振れない（.claude/rules/billing.md §4）。**画面が両方に単位を書く。**
 *
 * ── 金額は `null` を取りうる ────────────────────────────
 * 確定した数字が無い期間・施設は `null`。**0 円ではない**
 * （docs/DECISIONS.md #132 と同じ扱い）。「無償だった」と「まだ確定して
 * いない」を同じ数字で表さない。
 */

import { z } from "zod";

import { monthSchema } from "./dashboard.js";

/**
 * 請求状況の 1 行に出す状態（§7.2 の「状態」欄）。
 *
 * **`billingPeriod.status`（§2.8）と `invoice.status`（§2.5）を 1 本に
 * 畳んだ表示用の値で、DB の状態ではない。** 締めの前は締めの状態が、
 * 請求書が起きたあとは請求書の状態が、その取引先の「いま」を表す。
 * 画面が 2 つの状態機械を突き合わせる形にすると、同じ判断が
 * 画面の数だけ増える。
 *
 * `PARTIALLY_PAID` を持たないのは、一部入金を表す表がまだ無いため
 * （docs/OPEN_QUESTIONS.md #076。入金は全額のみ・一部入金は 409）。
 */
export const VENDOR_BILLING_STATES = [
  /** 締めが `OPEN`。まだ集計中で、金額が動く。 */
  "AGGREGATING",
  /** 締めが `REVIEWING`。ホテルの確認待ち。 */
  "REVIEWING",
  /** 締めが `AGREED`。合意済で、まだ請求書を起こしていない。 */
  "AGREED",
  /** 請求書が `CONFIRMED`。発行済だが未送付。 */
  "ISSUED",
  /** 請求書が `SENT` / `VIEWED`。 */
  "SENT",
  /** 請求書が `PAID`。 */
  "PAID",
  /** 請求書が `OVERDUE`。支払期限を過ぎている。 */
  "OVERDUE",
  /** 請求書が `VOIDED`。取り消した。 */
  "VOIDED",
] as const;

export type VendorBillingState = (typeof VENDOR_BILLING_STATES)[number];

/** 請求状況の 1 行（§7.2 上段）。**取引先ごと。施設ごとではない。** */
export const vendorBillingRowSchema = z.object({
  counterpartyId: z.string().min(1),
  /** 表示名。**請求書があれば発行時に固定した名前**（billing.md §6）。 */
  counterpartyName: z.string().min(1),
  /** 締めの期間（両端を含む）。請求書だけがある場合は請求書の期間。 */
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * 金額（**税込**・整数・円）。
   *
   * 請求書があればその税込合計。無ければ、双方合意の履歴に残っている
   * **最後に見せた明細の写し**（`billingPeriodReview.snapshotTotalAmount`）。
   * どちらも無い（まだ誰にも見せていない）期間は `null`。
   */
  amount: z.number().int().nullable(),
  /** 金額が請求書そのものの額か。偽なら合意の途中で見せた写し。 */
  isConfirmedAmount: z.boolean(),
  state: z.enum(VENDOR_BILLING_STATES),
  /** 要対応か（§7.2 の「← 要対応」）。判定は `lib/dashboard/vendor.ts`。 */
  needsAction: z.boolean(),
  /** 締めの ID。請求書だけがある（締めを経ていない）場合は `null`。 */
  billingPeriodId: z.string().nullable(),
  invoiceId: z.string().nullable(),
});

export type VendorBillingRow = z.infer<typeof vendorBillingRowSchema>;

/** 施設別収支の 1 行（§7.2 下段）。 */
export const vendorPropertyRowSchema = z.object({
  propertyId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  /** 清掃実績（rollup）。**取り消したタスクを含まない。** */
  totalTasks: z.number().int().min(0),
  /** 実働時間の分子（分）。**画面が 60 で割って「631h」にする。** */
  totalMinutes: z.number().int().min(0),
  /** 請求額（**税抜**・整数・円）。その月の請求書が無ければ `null`。 */
  billedAmount: z.number().int().nullable(),
});

export type VendorPropertyRow = z.infer<typeof vendorPropertyRowSchema>;

/** 上段の 3 つ（§7.2 の見出し行）。 */
export const vendorPlanSummarySchema = z.object({
  /** 受託施設。 */
  propertyCount: z.number().int().min(0),
  /**
   * 稼働スタッフ（名）。**現場ロールの有効な在籍者を数えたもの**で、
   * 「その月に働いた人数」ではない（docs/DECISIONS.md #135）。
   */
  staffCount: z.number().int().min(0),
  /** 清掃実績（rollup）。 */
  totalTasks: z.number().int().min(0),
  /** 売上合計（**税込**）。確定した請求書が 1 枚も無ければ `null`。 */
  salesTotal: z.number().int().nullable(),
  /**
   * 未回収（**税込**）。`paidAt` が無い請求書の合計。
   *
   * **一部入金を表せない**（OPEN_QUESTIONS #076）。入金は全額のみなので、
   * 「入金済でない請求書の全額」が未回収になる。
   */
  unpaidTotal: z.number().int().nullable(),
});

export type VendorPlanSummary = z.infer<typeof vendorPlanSummarySchema>;

/** `GET /api/v1/dashboard/vendor` の応答。 */
export const vendorPlanResponseSchema = z.object({
  month: monthSchema,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** その月に集計の行が 1 つでもあるか（`dashboard.ts` の `hasRollup`）。 */
  hasRollup: z.boolean(),
  summary: vendorPlanSummarySchema,
  billing: z.array(vendorBillingRowSchema),
  properties: z.array(vendorPropertyRowSchema),
});

export type VendorPlanResponse = z.infer<typeof vendorPlanResponseSchema>;

/**
 * 時間単価の警告のしきい値（§7.2 MUST「組織平均の 85% を下回る施設」）。
 *
 * **百分率の整数で持つ。** 0.85 を掛けると浮動小数点が金額の判定に
 * 入る（billing.md §4）。判定は `billedAmount * 100 < 平均 * 85` の形で
 * 整数のまま行う（`lib/dashboard/format.ts` の `isLowHourlyRate()`）。
 */
export const LOW_HOURLY_RATE_PERCENT = 85;
