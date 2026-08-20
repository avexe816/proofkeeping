/**
 * プラットフォーム運営（stek.ai 側）のテーブル。**SHARD_00 の実体だけを正とする。**
 *
 * task: docs/tasks/PF-01.md
 * 決定: docs/DECISIONS.md #220（運営面をテナント面と交わらせない）
 *
 * ── テナントの表と交わらせない ──────────────────────────
 * 運営の画面は本質的にテナント横断だが、architecture.md §3 は横断の
 * JOIN・集計を禁じ、security.md §2 は全シャード走査を禁じている。
 * #220 の答えは**集合を分けること**で、この 2 表はテナントの表と
 * JOIN しない。**運営側のハンドラは `getTenantDb()` を呼ばない**し、
 * テナント側のハンドラは `platform_*` を読まない。
 *
 * ── 16 シャードすべてに作る ─────────────────────────────
 * 使うのは SHARD_00 の実体だけだが、**定義は全シャードへ流す**
 * （`global.ts` と同じ理由 — `schema_version` が食い違うと起動時の
 * 不一致検出が正常時に発火して書き込み系 API が 503 になる）。
 *
 * ── `Role` に `PLATFORM_ADMIN` を足さない ────────────────
 * #220 の却下案 3。ロールは組織スコープの概念で `membership` に紐づくため、
 * 足すと**運営担当者がどこかのテナントの構成員になる。** PK-IMPL-CONTRACT §2 も
 * 「組織内ロールではなく未実装」と書いており、これに従う。
 *
 * ── 置いてよいもの ──────────────────────────────────────
 * 運営担当者の身元と、運営面の操作記録だけ。**テナントの業務データを
 * 置かない。** テナントの事実は Queue コンシューマ経由のスナップショットで
 * 渡る（#220 の 2 / PF-02 の担当）。
 */

import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/** 運営担当者の状態。**無効化しても行は消さない**（監査の追跡のため）。 */
export const PLATFORM_OPERATOR_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type PlatformOperatorStatus = (typeof PLATFORM_OPERATOR_STATUSES)[number];

/**
 * 運営担当者（PK-IMPL-CONTRACT §3.5）。
 *
 * **認証はメール＋パスワード。** 現場系の `orgShortId`＋スタッフ番号は
 * 使えない — 運営担当者はどの組織にも属さないので解決できない（#220 の 3）。
 * メールの一意性は、この表が SHARD_00 の 1 か所にしか無いことで成立する
 * （テナントの `user` と違い、組織スコープを持たない）。
 */
export const platformOperator = sqliteTable(
  "platform_operator",
  {
    id: text("id").primaryKey(),
    /** ログイン識別子。**全局で一意**（主キーの次に強い制約を張る）。 */
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    /**
     * PBKDF2-SHA256 210,000 回の自己記述文字列（security.md §2）。
     * **方式と反復回数を含む**ので、反復回数の引き上げを段階移行できる。
     */
    passwordHash: text("password_hash").notNull(),
    status: text("status", { enum: PLATFORM_OPERATOR_STATUSES }).notNull().default("ACTIVE"),
    /** 連続失敗回数。10 回で 30 分ロック（security.md §2）。 */
    failedAttempts: integer("failed_attempts").notNull().default(0),
    /** ロック解除の時刻。`null` はロックされていない。 */
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    /**
     * 2 要素認証の秘密。**列だけ置く。** 方式は未決
     * （OPEN_QUESTIONS #109）で、PF-01 では読み書きしない。
     */
    twoFactorSecret: text("two_factor_secret"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_platform_operator_status").on(t.status)],
);

/**
 * 運営面の操作記録。
 *
 * **UPDATE / DELETE の口を作らない**（INV-30 と同じ扱い）。訂正は
 * 新しい行を足す。運営が自分の痕跡を消せる形にしない。
 *
 * `targetOrganizationId` は「どのテナントに対する操作か」であって、
 * テナントの表への外部キーではない（シャードが違うので張れない）。
 * **シャード番号は入れない**（architecture.md §1 / #220 の 5）。
 */
export const platformAuditLog = sqliteTable(
  "platform_audit_log",
  {
    id: text("id").primaryKey(),
    /** `platform_operator.id`。ログイン失敗など主体が定まらない操作は `null`。 */
    operatorId: text("operator_id"),
    /** `platform.login` / `platform.login.failed` など。 */
    action: text("action").notNull(),
    /** 操作の対象になったテナント。全体に対する操作は `null`。 */
    targetOrganizationId: text("target_organization_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** 補足。**個人情報を入れない**（security.md §3・§6）。 */
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_platform_audit_created").on(t.createdAt),
    index("idx_platform_audit_operator").on(t.operatorId, t.createdAt),
  ],
);
