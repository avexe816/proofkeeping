/**
 * 契約とモジュールの利用可否。
 *
 * task: docs/tasks/P0-06.md
 * 仕様: docs/PK-SPEC-P7.md §3（課金）/ docs/PK-BIZ-PLAN.md §4〜§5（版数）
 *
 * ── 2 つの課金モデルが併存している ──────────────────────
 * PK-SPEC-P7 §3.1 はモジュール別（Platform / Housekeeping Core / Audit / …）、
 * PK-BIZ-PLAN §4 は版数（Base / Pro / Ent）で書かれており、金額の出し方が違う。
 * どちらが正かは未決なので、**契約の単位（subscription）と機能の可否
 * （moduleEntitlement）を分けて**両方を表現できる形にしてある。
 * 金額の計算は P7-04 の担当。OPEN_QUESTIONS に起票済み。
 *
 * 金額はすべて整数（円）。浮動小数点を使わない（.claude/rules/billing.md §4）。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn, timestamps } from "./columns.js";

/** 版数（docs/PK-BIZ-PLAN.md §4.2）。 */
export const SUBSCRIPTION_PLANS = ["BASE", "PRO", "ENT"] as const;

/**
 * 契約状態。
 *
 * `PAST_DUE` でも 14 日間は全機能を維持する（PK-SPEC-P7 §3.4）。
 * 支払い遅延で清掃現場を止めない。この判定は P7-04 が行う。
 */
export const SUBSCRIPTION_STATUSES = ["TRIAL", "ACTIVE", "PAST_DUE", "CANCELED"] as const;

export const BILLING_CYCLES = ["MONTHLY", "ANNUAL"] as const;

/** モジュール（docs/PK-SPEC-P7.md §3.1）。P0-12 の `assertEntitlement(ctx, "AUDIT")` と揃える。 */
export const MODULE_CODES = [
  "PLATFORM",
  "HOUSEKEEPING_CORE",
  "AUDIT",
  "BILLING",
  "VENDOR_PLAN",
  "INTEGRATION",
] as const;

export type ModuleCode = (typeof MODULE_CODES)[number];

/** 有効化の由来。トライアル終了時に `TRIAL` の行だけを落とせるようにする。 */
export const ENTITLEMENT_SOURCES = ["PLAN", "ADDON", "TRIAL"] as const;

/** 組織の契約。1 組織 1 行。履歴は AuditLog に残す。 */
export const subscription = sqliteTable(
  "subscription",
  {
    ...primaryId,
    ...tenantColumn,
    plan: text("plan", { enum: SUBSCRIPTION_PLANS }).notNull(),
    status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull(),
    billingCycle: text("billing_cycle", { enum: BILLING_CYCLES }).notNull().default("MONTHLY"),
    /** トライアルは 30 日。終了で読み取り専用へ移行し、データは 90 日保持（PK-SPEC-P7 §2.5）。 */
    trialEndsAt: integer("trial_ends_at", { mode: "timestamp_ms" }),
    currentPeriodStart: integer("current_period_start", { mode: "timestamp_ms" }),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
    /** 室単価（円）。課金単位は客室数（INV-34）。記録件数・写真枚数で課金しない。 */
    unitPriceYen: integer("unit_price_yen").notNull().default(0),
    /** 最低利用料（円）。 */
    minimumChargeYen: integer("minimum_charge_yen").notNull().default(0),
    /** Stripe 側の識別子（P7-04）。P0 では書き込まない。 */
    externalRef: text("external_ref"),
    canceledAt: integer("canceled_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_subscription_org").on(t.organizationId)],
);

/**
 * モジュールの利用可否。
 *
 * `propertyId` が null なら組織全体、値があれば施設単位
 * （P0-12 の完了条件「施設単位・組織単位の両方に対応」）。
 * 未購入モジュールの API は 402 を返す。
 *
 * SQLite の UNIQUE は NULL 同士を別値として扱うため、組織単位の行
 * （`propertyId` が null）の重複は DB では弾けない。P0-12 の
 * `assertEntitlement()` は複数行が返っても成立するよう「1 行でも
 * `isEnabled` が真なら許可」で判定する。
 */
export const moduleEntitlement = sqliteTable(
  "module_entitlement",
  {
    ...primaryId,
    ...tenantColumn,
    /** null = 組織全体。 */
    propertyId: text("property_id"),
    moduleCode: text("module_code", { enum: MODULE_CODES }).notNull(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ENTITLEMENT_SOURCES }).notNull().default("PLAN"),
    validFrom: integer("valid_from", { mode: "timestamp_ms" }),
    /** null = 無期限。 */
    validUntil: integer("valid_until", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_module_entitlement").on(t.organizationId, t.propertyId, t.moduleCode),
    index("idx_module_entitlement_lookup").on(t.organizationId, t.moduleCode),
  ],
);
