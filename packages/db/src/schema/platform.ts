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

import { integer, sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * テナントのスナップショット（PF-02 / #220 の 2）。
 *
 * 運営画面が要る数字は全部テナントの中にあるが、**リクエスト時に 16 シャードへ
 * fan-out することは禁止されている**（architecture.md §3 / security.md §2）。
 * Queue コンシューマが **1 テナントずつ**読んで、ここへ 1 行書く。
 * 運営画面はこの表だけを読む。
 *
 * ── 測った値だけを置く。判定を置かない ──────────────────
 * 「要支援」「注意」は**読むときに**閾値と突き合わせて出す
 * （`packages/engine` の `judgeTenantQuality()`）。閾値は PF-14 の
 * 「運用（変更可）」から来るので、焼き込むと**値を変えた瞬間に過去の行と
 * 食い違う。** 保存するのは分子・分母と中央値まで。
 *
 * ── 割合を持たない ──────────────────────────────────────
 * 完備率も既定値のまま比率も**件数から都度出す。** 割合を列にすると、
 * 分母 0 のときの扱い（0% なのか「まだ無い」なのか）が列の中に隠れる。
 *
 * ── 個人を特定できる列を置かない（INV-10）───────────────
 * 氏名・メール・端末 ID を運営面へ渡さない。組織の名前は載せる
 * （テナント一覧の見出しで、個人ではない）。
 *
 * **`orgShortId` を持たない**（表示に使わない）。
 * **シャード番号の列を持たない**（architecture.md §1）。
 */
export const platformTenantSnapshot = sqliteTable(
  "platform_tenant_snapshot",
  {
    id: text("id").primaryKey(),
    /**
     * どのテナントのぶんか。**テナントの表への外部キーではない**
     * （シャードが違うので張れない / `platform_audit_log` と同じ扱い）。
     */
    organizationId: text("organization_id").notNull(),
    /** 業務日（`YYYY-MM-DD` / architecture.md §7）。カレンダー日ではない。 */
    businessDate: text("business_date").notNull(),

    /** 組織名。テナント一覧の見出し。 */
    name: text("name").notNull(),
    /** 契約プラン（`SUBSCRIPTION_PLANS`）。契約が無ければ `null`。 */
    plan: text("plan"),
    /** 契約状態（`SUBSCRIPTION_STATUSES`）。**運営面の 4 状態に翻訳しない。** */
    subscriptionStatus: text("subscription_status"),
    /** 契約日（`YYYY-MM-DD`）。一覧の「2024/04 契約」。 */
    contractedOn: text("contracted_on"),
    /** 試用の期限（`YYYY-MM-DD`）。「残 18 日」はここから出す。 */
    trialEndsOn: text("trial_ends_on"),

    propertyCount: integer("property_count").notNull().default(0),
    roomCount: integer("room_count").notNull().default(0),
    /** 課金対象の客室数（売れる客室 / INV-34）。`roomCount` と別に持つ。 */
    billableRoomCount: integer("billable_room_count").notNull().default(0),
    staffCount: integer("staff_count").notNull().default(0),

    /**
     * 完備率の**分母**。その業務日に完了したタスク数
     * （`daily_property_rollup.completedTasks` の施設合計）。
     */
    completedTasks: integer("completed_tasks").notNull().default(0),
    /** 完備率の**分子**。観察記録が入ったタスク数。 */
    observationsRecorded: integer("observations_recorded").notNull().default(0),
    /** 「今回は記録しない」を選んだ数（ui-writing.md §4）。**理由は持たない。** */
    observationsSkipped: integer("observations_skipped").notNull().default(0),
    /** そのうち既定値のまま確定した数。比率はここと分子から出す。 */
    observationsUsedDefaults: integer("observations_used_defaults").notNull().default(0),
    /** 入力所要時間の中央値（ミリ秒）。計測が 1 件も無ければ `null`。 */
    inputDurationMedianMs: integer("input_duration_median_ms"),

    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    // 1 テナント 1 業務日 1 行。**再計算方式の UPSERT がこれを鍵にする。**
    uniqueIndex("uq_platform_snapshot").on(t.organizationId, t.businessDate),
    // 一覧は「最新の業務日」を横断で引く。
    index("idx_platform_snapshot_date").on(t.businessDate),
  ],
);

/**
 * 運営の「運用（変更可）」設定（PF-14 の右カラム / PF-02・PF-05 が読む）。
 *
 * **1 行しか持たない**（`id` は固定値 `PLATFORM_SETTING_ID`）。項目ごとに
 * 行を作る key-value にしない — 型が付かず、既定値の在り処が散る。
 *
 * ── ここに置いてよいのは PF-14 の 5 項目だけ ─────────────
 * 左カラム「設計（変更不可）」の 7 項目は**コード上の定数のまま**で、
 * ここへ移さない（PF-14 の「やらないこと」）。**項目を勝手に増やさない** —
 * 増やした瞬間、プロトタイプに無い設定が製品に生える。
 *
 * ── 書き込みは PF-14 の担当 ─────────────────────────────
 * 変更は「運営管理者が申請 → **承認者 2 名** → 次の運用開始時刻に反映」。
 * PF-02 は**読むだけ**で、行が無ければ既定値を使う。
 */
export const platformOperationSetting = sqliteTable("platform_operation_setting", {
  id: text("id").primaryKey(),
  /** 入力所要時間の基準（秒）。既定 10。**これ未満は形骸化の疑い。** */
  inputDurationFloorSeconds: integer("input_duration_floor_seconds").notNull().default(10),
  /** 既定値のまま比率の閾値（%）。既定 70。 */
  defaultRateThresholdPercent: integer("default_rate_threshold_percent").notNull().default(70),
  /** 写真の保存期間（日）。既定 90。 */
  photoRetentionDays: integer("photo_retention_days").notNull().default(90),
  /** 1 人あたり担当室数の上限（室）。既定 16。 */
  roomsPerStaffLimit: integer("rooms_per_staff_limit").notNull().default(16),
  /** メンテナンス時間帯の開始・終了（日本時間の `HH:MM`）。既定 03:00〜04:00。 */
  maintenanceStartJst: text("maintenance_start_jst").notNull().default("03:00"),
  maintenanceEndJst: text("maintenance_end_jst").notNull().default("04:00"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
