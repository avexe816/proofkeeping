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
 *
 * ── ログイン識別子（P0-08 / DECISIONS #018）─────────────
 * この制約のため、**メールアドレスはログイン識別子に使わない。**
 * 識別子は `orgShortId` + `staffNumber` + 認証情報の 3 フィールドで、
 * 組織の解決は SHARD_00 の `org_directory`（`lookupOrganizationId()`）が行う。
 * `email` は通知の送信先としてのみ保持する。
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
 * 管理系は orgShortId＋スタッフ番号＋パスワード、現場系（CLEANER / INSPECTOR）は
 * orgShortId＋スタッフ番号＋PIN 4 桁でログインする（security.md §2）。
 * 認証情報はロールによってどちらか一方しか持たないため、
 * `passwordHash` / `pinHash` は null 許容にしてある。
 *
 * **`passwordHash` / `pinHash` を監査ログの before / after に載せない**
 * （security.md §6）。マスクは `recordAudit()`（P0-11）の責務。
 */
export const user = sqliteTable(
  "user",
  {
    ...primaryId,
    ...tenantColumn,
    /**
     * 通知の送信先。**ログイン識別子ではない**（DECISIONS #018）。
     * 持たないユーザーがありうる。
     */
    email: text("email"),
    /**
     * PBKDF2-SHA256 のハッシュ（DECISIONS #019）。
     * `pbkdf2$sha256$5000$<salt>$<hash>` の自己記述文字列で、方式と反復回数を含む。
     * **形式を解釈してよいのは `apps/web/src/lib/auth/password.ts` だけ。**
     */
    passwordHash: text("password_hash"),
    /**
     * ログイン識別子の 2 番目。組織内で一意（下の `uq_user_org_staff_number`）。
     *
     * **全ロールで必須。** 列を null 許容のままにしてあるのは、後方互換のみという
     * マイグレーション方針（architecture.md §6）に従い、既存行を壊さないため。
     * null の行はログインできない（認証経路が弾く）。
     */
    staffNumber: text("staff_number"),
    /**
     * PBKDF2-SHA256 のハッシュ（DECISIONS #021）。
     * `pbkdf2$sha256$5000$<salt>$<hash>` の自己記述文字列。
     * **反復回数がパスワードより低い**のは、4 桁 PIN では KDF の強度差が
     * 効かないため（理由は `apps/web/src/lib/auth/pin.ts` の冒頭）。
     * **形式を解釈してよいのは `apps/web/src/lib/auth/pin.ts` だけ。**
     * 連番・ゾロ目は登録時に拒否する（`pinSchema` / security.md §2）。
     */
    pinHash: text("pin_hash"),
    /** 初回変更を強制する（security.md §2）。 */
    pinMustChange: integer("pin_must_change", { mode: "boolean" }).notNull().default(true),
    displayName: text("display_name").notNull(),
    /** モバイルのみ多言語。管理画面は日本語のみ（ui-writing.md §1）。 */
    locale: text("locale").notNull().default("ja"),
    /**
     * 連続失敗回数。パスワード 10 回で 30 分ロック（P0-08 が実装）。
     *
     * security.md §2 は PIN にも 5 回で 15 分を定めるが、**P0-09 では
     * 数えていない**（PIN の総当たりはレート制限が止めている）。
     * この列はパスワードと PIN で共有しているため、PIN 側で数え始めるなら
     * **列を分けるところから設計すること。** 共有のままだと
     * 「PIN の失敗でパスワードがロックされる」が起きる。
     */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    /** パスワードを設定した時刻。有効期限には使わず、運用調査と再設定の判断に使う。 */
    passwordUpdatedAt: integer("password_updated_at", { mode: "timestamp_ms" }),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_user_org_email").on(t.organizationId, t.email),
    uniqueIndex("uq_user_org_staff_number").on(t.organizationId, t.staffNumber),
  ],
);

/**
 * パスワードの世代。**直近 3 世代の再利用を禁止するためだけに存在する**
 * （security.md §2 / P0-08）。
 *
 * ── 何を置くか ──────────────────────────────────────────
 * 過去のハッシュだけ。**平文・ヒント・パスワードの長さや文字種を置かない。**
 * 現在有効なハッシュもここに 1 行入る（設定のたびに追加するため）。
 *
 * ── 行を増やし続けない ──────────────────────────────────
 * 照合に要るのは直近 3 世代なので、設定時に古い行を削る
 * （`repositories/user.ts` の `setPasswordHash()`）。**残しても価値が無く、
 * 漏洩時に総当たりの的が増えるだけ。** 監査の証跡は `AuditLog` が持つ。
 */
export const passwordHistory = sqliteTable(
  "password_history",
  {
    ...primaryId,
    ...tenantColumn,
    userId: text("user_id").notNull(),
    /** 当時の `user.password_hash` をそのまま。形式は自己記述（DECISIONS #019）。 */
    passwordHash: text("password_hash").notNull(),
    /** 訂正・更新はしない。追加と削除だけの表なので `updatedAt` を持たない。 */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_password_history_user").on(t.organizationId, t.userId, t.createdAt)],
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
