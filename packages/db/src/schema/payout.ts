/**
 * スタッフ支払集計（P5-18 / docs/PK-SPEC-PAY.md §1）。
 *
 * ルール: .claude/rules/billing.md §4・§5 / .claude/rules/security.md §5
 *
 * ── 給与計算ではない ────────────────────────────────────
 * ここにあるのは**支給総額の基礎**（タスク実績 × 単価 ＋ 調整行）まで。
 * 控除（社会保険・源泉徴収・年末調整）の列を足さないこと（PAY §0.2 MUST）。
 *
 * ── 個人情報を持たない ──────────────────────────────────
 * 本籍・住所・生年月日・マイナンバー・口座情報の列を作らない
 * （PAY §1.1 MUST / PK-SPEC-P8 §1.3 と同じ）。スタッフの同定は
 * `membershipId` だけで行い、氏名は表示時に user から引く。
 *
 * ── P8-01 との関係 ──────────────────────────────────────
 * `staffPayProfile` は P8-01 `staffProfile` の**先行サブセット。**
 * P8-01 実装時はこの表を包含・拡張する（別の台帳を並べない）。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { activeFlag, primaryId, tenantColumn, timestamps } from "./columns.js";
import { TASK_TYPES } from "./task.js";

/** 雇用区分（PAY §1.1）。CONTRACTOR は支払明細書（仕入明細書方式）の対象。 */
export const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "CONTRACTOR"] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** 単価の種類（PAY §1.2）。 */
export const PAY_UNIT_TYPES = ["PER_TASK", "HOURLY"] as const;

export type PayUnitType = (typeof PAY_UNIT_TYPES)[number];

/** 支払期間の状態（PAY §3.1）。`CONFIRMED` から先は動かない。 */
export const PAYOUT_PERIOD_STATUSES = ["OPEN", "REVIEWING", "CONFIRMED"] as const;

export type PayoutPeriodStatus = (typeof PAYOUT_PERIOD_STATUSES)[number];

/** 明細行の種類（PAY §1.4）。 */
export const PAYOUT_LINE_TYPES = ["TASK", "ADJUSTMENT", "REIMBURSEMENT"] as const;

export type PayoutLineType = (typeof PAYOUT_LINE_TYPES)[number];

/**
 * スタッフの支払属性（PAY §1.1）。
 *
 * `membership` を拡張しない（支払集計を使わない組織に列を持たせない —
 * P8 §1.3 と同じ判断）。1 スタッフ 1 行。
 */
export const staffPayProfile = sqliteTable(
  "staff_pay_profile",
  {
    ...primaryId,
    ...tenantColumn,
    membershipId: text("membership_id").notNull(),
    employmentType: text("employment_type", { enum: EMPLOYMENT_TYPES }).notNull(),
    /** 適格請求書発行事業者の登録番号（T+13桁）。CONTRACTOR のみ。 */
    invoiceRegistrationNo: text("invoice_registration_no"),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_staff_pay_profile").on(t.organizationId, t.membershipId),
    index("idx_staff_pay_profile").on(t.organizationId, t.isActive),
  ],
);

/**
 * 支払単価（PAY §1.2）。`pricingRule`（請求単価）のミラー。
 *
 * **請求と支払の単価を同じ表に混ぜない。** 見る人が違い（発注元 vs 組織内）、
 * 消える条件も違う。解決順序は `@pk/billing` の `resolvePayRule()`。
 */
export const payRule = sqliteTable(
  "pay_rule",
  {
    ...primaryId,
    ...tenantColumn,
    /** null = 全スタッフ既定。 */
    membershipId: text("membership_id"),
    /** null = 全施設。 */
    propertyId: text("property_id"),
    /** null = 全種別。 */
    taskType: text("task_type", { enum: TASK_TYPES }),
    unitType: text("unit_type", { enum: PAY_UNIT_TYPES }).notNull(),
    /** 円。整数のみ（billing.md §4）。HOURLY は時給。 */
    unitPrice: integer("unit_price").notNull(),
    /** `YYYY-MM-DD`。null は開区間。 */
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    /** 小さいほうが勝つ（`pricingRule` と同じ / DECISIONS #122）。 */
    priority: integer("priority").notNull().default(100),
    ...timestamps,
  },
  (t) => [
    index("idx_pay_rule_membership").on(t.organizationId, t.membershipId),
    index("idx_pay_rule_property").on(t.organizationId, t.propertyId),
  ],
);

/**
 * 支払期間（PAY §1.3）。スタッフ × 期間で 1 行。`billingPeriod` と同型。
 */
export const payoutPeriod = sqliteTable(
  "payout_period",
  {
    ...primaryId,
    ...tenantColumn,
    membershipId: text("membership_id").notNull(),
    /** `YYYY-MM-DD`（業務日基準）。 */
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    status: text("status", { enum: PAYOUT_PERIOD_STATUSES }).notNull().default("OPEN"),
    aggregatedAt: integer("aggregated_at", { mode: "timestamp_ms" }),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    /** 確定時に採番（`PAY-{西暦}-{連番4桁}` / PAY §3.2）。 */
    documentNo: text("document_no"),
    /**
     * 支給総額の基礎（円）。集計・確定のたびに明細の和で更新する。
     * **CONFIRMED 以降は動かない**（状態遷移が守る）。一覧の表示と
     * 検索のための非正規化で、明細（`payoutLine`）が正。
     */
    totalAmount: integer("total_amount").notNull().default(0),
    /** 支払明細書 PDF の R2 キー（PAY §3.2）。生成前は null。 */
    pdfStorageKey: text("pdf_storage_key"),
    /** PDF のハッシュ（真実性の確保 / billing.md §2 と同じ扱い）。 */
    pdfSha256: text("pdf_sha256"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_payout_period").on(t.organizationId, t.membershipId, t.periodFrom, t.periodTo),
    index("idx_payout_period_status").on(t.organizationId, t.status, t.periodTo),
  ],
);

/**
 * 支払明細行（PAY §1.4）。
 *
 * TASK 行は再集計（再計算方式）のたびに作り直す。ADJUSTMENT /
 * REIMBURSEMENT（手入力）は再集計で消さない。**CONFIRMED の期間の行は
 * 変更しない**（訂正は赤伝方式 = 次の期間にマイナスの調整行 / PAY §3.1）。
 */
export const payoutLine = sqliteTable(
  "payout_line",
  {
    ...primaryId,
    ...tenantColumn,
    payoutPeriodId: text("payout_period_id").notNull(),
    lineNo: integer("line_no").notNull(),
    lineType: text("line_type", { enum: PAYOUT_LINE_TYPES }).notNull(),
    /** TASK 行の集計元施設。調整行は null。 */
    propertyId: text("property_id"),
    description: text("description").notNull(),
    /** 件数（PER_TASK）/ 分（HOURLY）/ 1（調整行）。 */
    quantity: integer("quantity").notNull(),
    /** TASK 行のみ。調整行は null。 */
    unitType: text("unit_type", { enum: PAY_UNIT_TYPES }),
    /** 円。調整行は金額そのもの（quantity = 1）。 */
    unitPrice: integer("unit_price").notNull(),
    /** 円。マイナス（控除ではなく赤伝の訂正）も取りうる。 */
    amount: integer("amount").notNull(),
    /** TASK 行の集計元タスク（証跡ドリルダウン / PAY §1.4）。 */
    taskIds: text("task_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** 調整行の理由。ADJUSTMENT / REIMBURSEMENT では必須（呼び出し側が強制）。 */
    reason: text("reason"),
    /** `NO_PAY_RULE` 等。単価が引けなかった行に立てる（黙って除外しない）。 */
    warning: text("warning"),
    ...timestamps,
  },
  (t) => [index("idx_payout_line_period").on(t.organizationId, t.payoutPeriodId, t.lineNo)],
);
