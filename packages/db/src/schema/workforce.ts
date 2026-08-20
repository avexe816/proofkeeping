/**
 * Workforce（P8 / 在留資格）。
 *
 * task: docs/tasks/P8-02.md
 * 仕様: docs/PK-SPEC-P8.md §1.4
 * 契約: docs/PK-IMPL-CONTRACT.md **INV-08**
 * ルール: .claude/rules/security.md §3（保存してはいけないデータ）
 *
 * ── スタッフ台帳はここに無い ────────────────────────────
 * `staffProfile` は**新しい表を作らず** `staff_pay_profile` に列を足した
 * （DECISIONS #223）。ここにあるのは在留資格だけ。
 *
 * ── 番号を保存しない ────────────────────────────────────
 * パスポート番号・在留カード番号・国籍・生年月日の列を作らない。
 * **期限の管理に要るのは種別と日付だけ**で、番号は要らない。
 * 番号を持つと、漏れたときの被害が桁で変わる（security.md §3）。
 *
 * ── 就労可否を判定しない ────────────────────────────────
 * 仕様 §1.4 MUST。「在留資格の種類から就労可否を自動判定しない。
 * 制度は変わるため、システムは期限の通知に限定する」。
 * したがって `statusType` に**可否を導く列を付けない**
 * （`canWork` のような列を足さないこと）。判断は事業者が行う。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn, timestamps } from "./columns.js";

/**
 * シフトの区分（PK-SPEC-P8 §1.5 / P8-03）。
 *
 * `WORK` だけが施設を持つ。休み（`OFF` / `PAID_LEAVE` / `SICK`）と
 * 研修（`TRAINING`）は施設に紐づかない。
 */
export const SHIFT_TYPES = ["WORK", "OFF", "PAID_LEAVE", "SICK", "TRAINING"] as const;

export type ShiftType = (typeof SHIFT_TYPES)[number];

/**
 * シフト（仕様 §1.5）。スタッフ × 業務日で 1 行。
 *
 * ── `staffProfileId` ではなく `membershipId` ────────────
 * 仕様の定義は `staffProfileId` だが、**タスクの担当（`assigneeId`）も
 * 支払（`payoutPeriod`）も `membershipId` で人を指している。**
 * 「出勤予定 26 / 出勤済み 24」の突き合わせ（P8-03 の KPI）は
 * シフトとタスクの照合そのもので、キーが違うと毎回台帳を経由する
 * 変換が挟まり、台帳の行が無いスタッフのシフトが組めなくなる。
 * 人の同定は `membershipId` に揃える（DECISIONS #223 と同じ向き）。
 *
 * ── シフトが無くても業務は成立する ──────────────────────
 * 仕様 §1.5 MUST「シフト未登録でも P1-14 の自動配分は動作すること」。
 * この表は**予定**であって、当日の実際（タスクの開始）を縛らない。
 */
export const shiftPlan = sqliteTable(
  "shift_plan",
  {
    ...primaryId,
    ...tenantColumn,
    /** `membership.id`。 */
    membershipId: text("membership_id").notNull(),
    /** `YYYY-MM-DD`（architecture.md §7）。 */
    businessDate: text("business_date").notNull(),
    shiftType: text("shift_type", { enum: SHIFT_TYPES }).notNull(),
    /** `WORK` のときだけ入る。休み・研修は null。 */
    propertyId: text("property_id"),
    /** `"09:00"` 形式。**予定**であって打刻ではない（打刻は作らない / DECISIONS #221）。 */
    startAt: text("start_at"),
    endAt: text("end_at"),
    breakMinutes: integer("break_minutes").notNull().default(60),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_shift_plan").on(t.organizationId, t.membershipId, t.businessDate),
    index("idx_shift_plan_date").on(t.organizationId, t.businessDate),
  ],
);

/**
 * 在留資格の種別（仕様 §1.4）。
 *
 * **表示のためだけの区分。** どれが就労できるかをコードに埋めない。
 * プロトタイプ ops 07 の内訳（特定技能1号 / 技能実習 / 永住者・定住者 /
 * 留学（資格外活動許可） / 日本国籍）はこの語彙から作る。
 */
export const RESIDENCY_STATUS_TYPES = [
  "SPECIFIED_SKILLED_1",
  "SPECIFIED_SKILLED_2",
  "TRAINING_EMPLOYMENT",
  "PERMANENT",
  "SPOUSE",
  "STUDENT_PART_TIME",
  "OTHER",
  "NOT_APPLICABLE",
] as const;

export type ResidencyStatusType = (typeof RESIDENCY_STATUS_TYPES)[number];

/**
 * 在留資格（仕様 §1.4）。1 スタッフ 1 行。
 *
 * **履歴表にしない。** 更新のたびに行が増えると「いまの期限」を引くのに
 * 最新行の判定が要り、期限切れの判定が静かにずれる。訂正の履歴は
 * `AuditLog`（security.md §6）が持つ。
 */
export const residencyRecord = sqliteTable(
  "residency_record",
  {
    ...primaryId,
    ...tenantColumn,
    /** `staff_pay_profile.id`。 */
    staffProfileId: text("staff_profile_id").notNull(),

    statusType: text("status_type", { enum: RESIDENCY_STATUS_TYPES }).notNull(),
    /** 表示用の任意ラベル。制度の名称が変わっても表を作り直さずに済む。 */
    statusLabel: text("status_label"),
    /** `YYYY-MM-DD`。`NOT_APPLICABLE`（日本国籍など）では null。 */
    expiresOn: text("expires_on"),
    /** 更新手続きを申請した日 `YYYY-MM-DD`。 */
    renewalAppliedOn: text("renewal_applied_on"),
    /** 資格外活動許可の要否。**要否を持つだけで、可否を判定しない。** */
    workPermitRequired: integer("work_permit_required", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 留学生等の週あたり上限時間。 */
    weeklyHourLimit: integer("weekly_hour_limit"),

    note: text("note"),
    /** 最後に更新した `membership.id`。訂正の追跡に要る。 */
    updatedById: text("updated_by_id").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_residency_staff").on(t.organizationId, t.staffProfileId),
    // 期限の近い順に引く。**組織内の索引**で、横断の集計には使わない。
    index("idx_residency_expires").on(t.organizationId, t.expiresOn),
  ],
);

/**
 * 研修プログラム（P8-10 / プロトタイプ ops 08「📚 研修プログラム」）。
 *
 * 組織ごとの研修項目（プロトタイプは 6 項目）。**成績・点数の列を
 * 持たない** — 研修は修了したかどうかだけを記録する（security.md §5）。
 */
export const trainingProgram = sqliteTable(
  "training_program",
  {
    ...primaryId,
    ...tenantColumn,
    name: text("name").notNull(),
    /** 目安時間（分）。表示のためだけ。 */
    expectedMinutes: integer("expected_minutes").notNull().default(0),
    /** 対応している資料の言語（プロトタイプの「対応言語」列）。 */
    languages: text("languages", { mode: "json" }).$type<string[]>().notNull().default([]),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index("idx_training_program").on(t.organizationId, t.isActive, t.sortOrder)],
);

/**
 * 研修の修了記録（P8-10）。スタッフ × 項目で 1 行。
 *
 * **全項目の修了 = 単独作業可の前提**（プロトタイプ 08「6項目すべて
 * 完了後に運営管理者が単独作業の可否を判断します」— 判断は人が行い、
 * この表は事実だけを持つ）。
 */
export const trainingRecord = sqliteTable(
  "training_record",
  {
    ...primaryId,
    ...tenantColumn,
    /** `membership.id`（シフト・タスクと同じキー / DECISIONS #223 の向き）。 */
    membershipId: text("membership_id").notNull(),
    programId: text("program_id").notNull(),
    /** `YYYY-MM-DD`。 */
    completedOn: text("completed_on").notNull(),
    /** 同行者（`membership.id`）。単独で受けた研修は null。 */
    mentorMembershipId: text("mentor_membership_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_training_record").on(t.organizationId, t.membershipId, t.programId),
    index("idx_training_record_member").on(t.organizationId, t.membershipId),
  ],
);

/**
 * 資格・講習の記録（P8-10 / プロトタイプ ops 08「📅 資格・講習の更新」）。
 *
 * 在留資格（`residencyRecord`）とは**別物** — こちらは衛生講習などの
 * 業務資格で、読める相手も広い（台帳と同じ扱い）。1 人が複数持てる。
 */
export const certificationRecord = sqliteTable(
  "certification_record",
  {
    ...primaryId,
    ...tenantColumn,
    /** `membership.id`。 */
    membershipId: text("membership_id").notNull(),
    /** 講習の名称（「衛生管理者講習」など）。マスタ化しない — 種類が少なく、自由記述で足りる。 */
    name: text("name").notNull(),
    /** `YYYY-MM-DD`。期限の無い資格は null。 */
    expiresOn: text("expires_on"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("idx_certification_member").on(t.organizationId, t.membershipId),
    index("idx_certification_expires").on(t.organizationId, t.expiresOn),
  ],
);
