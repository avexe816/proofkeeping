/**
 * ユーザー・所属・施設割当。
 *
 * task: docs/tasks/P0-06.md
 * ルール: .claude/rules/security.md §1 / §2 / §3 / §5
 *
 * ── ユーザーは組織スコープ ──────────────────────────────
 * 組織は 16 シャードへ分散するため、1 行のユーザーを複数組織で共有できない
 * （シャードをまたぐ参照が発生する）。同一人物が 2 組織に所属する場合は
 * 組織ごとに `user` 行を持つ（OPEN_QUESTIONS #005）。
 * その結果、メールアドレスの一意性は**組織内**でしか成立しない。
 * メール＋パスワードのログイン（P0-08）は、メールから組織を解決する手段を
 * 別途必要とする。OPEN_QUESTIONS に起票済み。
 *
 * ── 保存しないもの ──────────────────────────────────────
 * 宿泊者の情報は一切持たない（security.md §3）。ここにあるのは従業員の情報で、
 * 雇用管理に関する個人情報として扱う（同 §5）。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { activeFlag, primaryId, tenantColumn, timestamps } from "./columns.js";

/**
 * ロール（.claude/rules/security.md §1）。
 *
 * PK-IMPL-CONTRACT §2.10 は別の 6 語（SITE_LEAD / OPS_MANAGER / VIEWER /
 * PLATFORM_ADMIN）を挙げているが、その語彙は契約書 §2.10 / §4 以外に現れず、
 * security.md と PK-SPEC-P0 §23.1・P1〜P6 の全仕様書がこの 7 語で書かれている。
 * 食い違いは OPEN_QUESTIONS に起票済み。
 */
export const ROLES = [
  "OWNER",
  "ORG_ADMIN",
  "PROPERTY_MANAGER",
  "INSPECTOR",
  "CLEANER",
  "VENDOR_ADMIN",
  "AUDITOR",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * ユーザー。
 *
 * 管理系はメール＋パスワード、清掃スタッフは施設コード＋スタッフ番号＋PIN で
 * ログインする（security.md §2）。どちらか一方しか持たない行があるため、
 * 認証系の列はすべて null 許容にしてある。
 *
 * **`passwordHash` / `pinHash` を監査ログの before / after に載せない**
 * （security.md §6）。マスクは `recordAudit()`（P0-11）の責務。
 */
export const user = sqliteTable(
  "user",
  {
    ...primaryId,
    ...tenantColumn,
    /** 管理系ログイン用。清掃スタッフは持たないことがある。 */
    email: text("email"),
    /** bcrypt cost 12（security.md §2）。 */
    passwordHash: text("password_hash"),
    /** 清掃スタッフのログイン ID。施設コードと組み合わせて使う。 */
    staffNumber: text("staff_number"),
    /** bcrypt cost 10。連番・ゾロ目は登録時に拒否する（security.md §2）。 */
    pinHash: text("pin_hash"),
    /** 初回変更を強制する（security.md §2）。 */
    pinMustChange: integer("pin_must_change", { mode: "boolean" }).notNull().default(true),
    displayName: text("display_name").notNull(),
    /** モバイルのみ多言語。管理画面は日本語のみ（ui-writing.md §1）。 */
    locale: text("locale").notNull().default("ja"),
    /** 連続失敗回数。パスワード 10 回で 30 分、PIN 5 回で 15 分ロック。 */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_user_org_email").on(t.organizationId, t.email),
    uniqueIndex("uq_user_org_staff_number").on(t.organizationId, t.staffNumber),
  ],
);

/**
 * 組織への所属とロール。
 *
 * 施設スコープのロール（PROPERTY_MANAGER / INSPECTOR / CLEANER / VENDOR_ADMIN）の
 * `allowedPropertyIds` は列に持たず、`property_assignment` から構築する。
 * 割当の追加・削除が 1 か所で完結し、二重管理にならないため。
 */
export const membership = sqliteTable(
  "membership",
  {
    ...primaryId,
    ...tenantColumn,
    userId: text("user_id").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    /** 招待した membership の ID。監査で辿れるようにする（security.md §6）。 */
    invitedBy: text("invited_by"),
    invitedAt: integer("invited_at", { mode: "timestamp_ms" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_membership_org_user").on(t.organizationId, t.userId),
    index("idx_membership_org_role").on(t.organizationId, t.role),
  ],
);

/**
 * 施設スコープロールの担当施設。
 *
 * OWNER / ORG_ADMIN / AUDITOR は組織全体を見るため行を持たない
 * （.claude/rules/architecture.md §2 第1層の `scopeToProperties()` が分岐する）。
 */
export const propertyAssignment = sqliteTable(
  "property_assignment",
  {
    ...primaryId,
    ...tenantColumn,
    membershipId: text("membership_id").notNull(),
    propertyId: text("property_id").notNull(),
    assignedBy: text("assigned_by"),
    assignedAt: integer("assigned_at", { mode: "timestamp_ms" }).notNull(),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_property_assignment").on(t.organizationId, t.membershipId, t.propertyId),
    index("idx_property_assignment_property").on(t.organizationId, t.propertyId),
  ],
);
