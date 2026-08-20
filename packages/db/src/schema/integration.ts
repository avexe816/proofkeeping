/**
 * 外部連携（PMS・スマートロック・通知・公開 API）の表。
 *
 * task: docs/tasks/P0-22.md（`externalMapping` の定義のみ）/ docs/tasks/P6-01.md
 * 仕様: docs/PK-SPEC-P6.md §2 / §5.1 / §6.1 / §6.4
 * ルール: .claude/rules/security.md §7 / .claude/rules/ui-writing.md §6
 *
 * ── この表に平文の資格情報が 1 つも無い ─────────────────
 * security.md §7 は「API キー・パスワードを DB に平文保存しない。Workers KV に
 * 暗号化して保管し `credentialRef` で参照する」と定める。**仕様 §2.1 の
 * `webhookSecret` と §6.4 の `secret` は平文の列**なので、そのまま置かない。
 * どちらも KV の参照キーに読み替えてある（下の各表の注記を参照 /
 * docs/DECISIONS.md #138）。`apiKey.keyHash` はハッシュなのでそのまま置く。
 *
 * ここから導かれる不変条件:
 *   **この表の列に「復号すれば外部システムへログインできる値」が入らない。**
 *   D1 のバックアップが 1 本流出しても、それだけでは外部システムへ到達できない。
 *
 * ── 宿泊者の情報を置かない ──────────────────────────────
 * 外部システムから来る生データには宿泊者名が混ざる。`syncLog.rawSample` は
 * デバッグ用の先頭 3 件だけを持ち、**書き込む側がマスクしてから入れる**
 * （security.md §3 / `packages/db/src/mask.ts` の `maskSensitive()`）。
 * 保持は 7 日。マスクの責務を表の側では強制できないので、書き込み関数
 * （P6-04 以降）に寄せる。
 *
 * ── 仕様との差 ──────────────────────────────────────────
 * ① 時刻はすべて `timestamp_ms`。仕様 §2 は `mode: "timestamp"`（秒）と書くが、
 *    既存の全表が `timestamp_ms` で揃っている（columns.ts の列規約）。
 *    P3-01 / P4-01 / P5-01 と同じ判断。
 * ② 一意インデックス・索引の先頭に `organizationId` を足した。仕様の
 *    `uq_integration` / `uq_map_int` / `uq_push` / `uq_notif_pref` は組織を
 *    またいで一意になり、同居する別組織の行と衝突しうる（architecture.md §2
 *    第 1 層）。P3-01 以降と同じ判断。
 * ③ `webhookSecret` → `webhookSecretRef`、`outboundWebhook.secret` →
 *    `secretRef`（上記）。
 * ④ `integration.propertyId` が NULL のとき `uq_integration` は効かない
 *    （SQLite の UNIQUE は NULL 同士を等しいとみなさない）。**組織全体の
 *    連携は重複して作れてしまう。** `rule_config`（P4-01）が同じ形で、
 *    そこと揃えた。列を足して塞ぐこともできるが、仕様に無い列を増やすより
 *    作成する側で既存を引いてから入れる方針にする（docs/OPEN_QUESTIONS.md #085）。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { activeFlag, primaryId, tenantColumn } from "./columns.js";

// ────────────────────────────────────────────────────────────
// 語彙（PK-SPEC-P6 §2）
// ────────────────────────────────────────────────────────────

/** 連携の種類（§2.1）。 */
export const INTEGRATION_KINDS = [
  "PMS",
  "SMART_LOCK",
  "SELF_CHECKIN",
  "ACCOUNTING",
  "MESSAGING",
] as const;

export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/**
 * 連携の状態（§2.1）。
 *
 * `ERROR` は「5 回連続で失敗したので自動同期を止めた」状態（§3.4）。
 * **`ERROR` でも照合バッチは走る**（§3.4 MUST）。この列は照合の可否を決めない。
 */
export const INTEGRATION_STATUSES = [
  "INACTIVE",
  "CONNECTING",
  "ACTIVE",
  "ERROR",
  "SUSPENDED",
] as const;

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/** 同期の向き（§2.1 の `syncMode`）。 */
export const SYNC_MODES = ["PULL", "PUSH", "BOTH"] as const;

export type SyncMode = (typeof SYNC_MODES)[number];

/** 同期ログの向き（§2.2）。 */
export const SYNC_DIRECTIONS = ["INBOUND", "OUTBOUND"] as const;

export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

/** 同期の起動理由（§2.2）。 */
export const SYNC_TRIGGERS = ["CRON", "WEBHOOK", "MANUAL", "RETRY"] as const;

export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

/**
 * 同期の結果（§2.2）。
 *
 * `PARTIAL` は「受信したが一部を適用できなかった」。未マッピングの客室は
 * **エラーではなく `recordsSkipped`**（§2.3 MUST）。
 */
export const SYNC_STATUSES = ["SUCCESS", "PARTIAL", "FAILED"] as const;

export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** 対応付ける実体の種類（§2.3）。 */
export const EXTERNAL_ENTITY_TYPES = ["ROOM", "ROOM_TYPE", "PROPERTY"] as const;

export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

/**
 * 通知チャネル（§2.5）。
 *
 * `PUSH` は条件を満たさない端末で `IN_APP` へ落ちる（§5.2）。
 * **どのチャネルも業務の必須要素にしない**（ui-writing.md §6）。
 */
export const NOTIFICATION_CHANNELS = ["IN_APP", "PUSH", "EMAIL", "LINE"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * 通知イベント（§5.1）。
 *
 * **`CLEANER` に送ってよいのは `task.rework_assigned` だけ**（§5.1 MUST /
 * security.md §1）。配信側（P6-09）がロールで絞る。ここは語彙だけを持つ。
 */
/** 復元の状態（PK-SPEC-P7 §9.1）。 */
export const ARCHIVE_RESTORE_STATUSES = ["PENDING", "RUNNING", "READY", "EXPIRED", "FAILED"] as const;

export type ArchiveRestoreStatus = (typeof ARCHIVE_RESTORE_STATUSES)[number];

export const NOTIFICATION_EVENT_CODES = [
  "task.rework_assigned",
  "inspection.sla_exceeded",
  "room.urgent",
  "issue.critical",
  "finding.high",
  "integration.error",
  "invoice.sent",
  "invoice.overdue",
  "period.review_requested",
  "lostitem.retention_due",
  // P7-10。写真の保持期限が 30 日後に来る（PK-SPEC-P7 §4.5 MUST /
  // security.md §4）。**§5.1 の 10 件に無い 11 件目**（docs/DECISIONS.md #163 /
  // docs/OPEN_QUESTIONS.md #097）。§4.5 が「管理者へ通知し」と定めており、
  // 宛先が `PROPERTY_MANAGER` の `lostitem.retention_due` では代用できない。
  "photo.retention_due",
  // P7-09。退避データの復元が終わった（PK-SPEC-P7 §9.1 の手順 4
  // 「完了をメール通知」）。**§5.1 の 10 件に無い 12 件目**
  // （docs/DECISIONS.md #166）。
  "archive.restore_ready",
  // P8-02。在留資格の期限が近い（PK-SPEC-P8 §1.4 のアラート）。
  // **§5.1 の 10 件に無い 13 件目**（P6 の仕様が P8 を織り込んでいない。
  // photo.retention_due と同じ扱い / OPEN_QUESTIONS #097）。
  "residency.expiry_due",
] as const;

export type NotificationEventCode = (typeof NOTIFICATION_EVENT_CODES)[number];

/** 公開 API のスコープ（§6.2）。 */
export const API_SCOPES = [
  "occupancy:write",
  "signals:write",
  "tasks:read",
  "findings:read",
  "reports:read",
  "invoices:read",
  "webhooks:manage",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** 送信 Webhook の配信イベント（§6.4）。 */
export const OUTBOUND_WEBHOOK_EVENTS = [
  "room.status_changed",
  "task.completed",
  "inspection.failed",
  "issue.created",
  "finding.created",
  "invoice.issued",
] as const;

export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];

// ────────────────────────────────────────────────────────────
// 連携設定（§2.1）
// ────────────────────────────────────────────────────────────

/**
 * 外部システム 1 接続ぶんの設定。
 *
 * **`config` に資格情報を入れない。** API キー・パスワード・アクセストークンは
 * `credentialRef` が指す KV（`CREDENTIALS`）に暗号化して置く（security.md §7 /
 * P6-02）。`config` に入れてよいのは接続先の URL・タイムアウト・機種名など、
 * 漏れても外部システムへ到達できない値だけ。
 */
export const integration = sqliteTable(
  "integration",
  {
    ...primaryId,
    ...tenantColumn,
    /** `null` は組織全体。仕様 §2.1 のまま。上の注記 ④ を参照。 */
    propertyId: text("property_id"),
    kind: text("kind", { enum: INTEGRATION_KINDS }).notNull(),
    /** 連携先の識別子（`csv-generic` / `api-generic` など）。**分岐はアダプタ層だけ**（§1.1）。 */
    vendorCode: text("vendor_code").notNull(),
    displayName: text("display_name").notNull(),

    status: text("status", { enum: INTEGRATION_STATUSES }).notNull().default("INACTIVE"),
    /** 接続設定。**資格情報を入れない**（上記）。 */
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    /** `CREDENTIALS` KV のキー。値は暗号化して置く（P6-02）。 */
    credentialRef: text("credential_ref"),

    syncMode: text("sync_mode", { enum: SYNC_MODES }).notNull().default("PULL"),
    /** PULL のときの cron 式。 */
    syncCron: text("sync_cron"),
    /**
     * PUSH のときの署名鍵の**参照キー**。仕様 §2.1 の `webhookSecret`（平文）から
     * 読み替えた（上の注記 ③）。実体は `CREDENTIALS` KV に暗号化して置く。
     */
    webhookSecretRef: text("webhook_secret_ref"),

    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastErrorAt: integer("last_error_at", { mode: "timestamp_ms" }),
    /** 直近の失敗理由。**外部システムの応答をそのまま入れない**（個人情報が混ざりうる）。 */
    lastErrorMessage: text("last_error_message"),
    /** 5 でサーキットブレーカーが開く（§3.4）。成功で 0 に戻す。 */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_integration").on(
      t.organizationId,
      t.propertyId,
      t.kind,
      t.vendorCode,
    ),
    index("idx_integration_kind").on(t.organizationId, t.kind, t.status),
  ],
);

// ────────────────────────────────────────────────────────────
// 同期ログ（§2.2）
// ────────────────────────────────────────────────────────────

/**
 * 1 回ぶんの同期の記録。W-24（§7.3）がそのまま読む。
 *
 * **失敗も 1 行として残す。** 「その日の稼働記録が未取得」という状態を
 * 画面に出せることが §1.2 の要求で、例外を投げて消えると
 * 「連携が止まって気づかない」（§9 のリスク）が起きる。
 *
 * `rawSample` は**先頭 3 件だけ**・**マスク済み**・**保持 7 日**
 * （security.md §3）。3 つとも書き込む側の責務で、表では強制できない。
 */
export const syncLog = sqliteTable(
  "sync_log",
  {
    ...primaryId,
    ...tenantColumn,
    integrationId: text("integration_id").notNull(),
    direction: text("direction", { enum: SYNC_DIRECTIONS }).notNull(),
    trigger: text("trigger", { enum: SYNC_TRIGGERS }).notNull(),
    /** 取込の対象業務日（`YYYY-MM-DD`）。webhook 受信では `null`。 */
    targetDate: text("target_date"),

    status: text("status", { enum: SYNC_STATUSES }).notNull(),
    recordsReceived: integer("records_received").notNull().default(0),
    recordsApplied: integer("records_applied").notNull().default(0),
    /** 未マッピングはここ。**エラーにしない**（§2.3 MUST）。 */
    recordsSkipped: integer("records_skipped").notNull().default(0),
    recordsFailed: integer("records_failed").notNull().default(0),

    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** 先頭 3 件のみ。**個人情報をマスクしてから入れる**（security.md §3）。 */
    rawSample: text("raw_sample", { mode: "json" }).$type<unknown[]>(),

    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("idx_sync").on(t.organizationId, t.integrationId, t.startedAt)],
);

// ────────────────────────────────────────────────────────────
// マッピング（§2.3）
// ────────────────────────────────────────────────────────────

/**
 * 外部システムの ID と ProofKeeping の ID の対応。
 *
 * **未マッピングをエラーにしない**（§2.3 MUST）。`recordsSkipped` に数え、
 * W-13 が「未マッピング客室 N 件」として見せる（§7.1）。
 *
 * スマートロックの機器 ID もこの表に載る。`entityType = "ROOM"` で
 * `externalId` に機器 ID（`LOCK-302`）を入れる。**`integrationId` が
 * 一意キーに入っているので、PMS の部屋番号と機器 ID は衝突しない。**
 * 機器のための `entityType` を増やさないのは、対応先が結局は客室だから。
 */
export const externalMapping = sqliteTable(
  "external_mapping",
  {
    ...primaryId,
    ...tenantColumn,
    integrationId: text("integration_id").notNull(),
    entityType: text("entity_type", { enum: EXTERNAL_ENTITY_TYPES }).notNull(),
    /** ProofKeeping 側の ID（`room.id` など）。 */
    internalId: text("internal_id").notNull(),
    /** 外部システム側の ID。 */
    externalId: text("external_id").notNull(),
    /** 外部システム側の表示名。突き合わせの画面に出すためだけ。 */
    externalLabel: text("external_label"),
    ...activeFlag,
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_map_int").on(t.organizationId, t.integrationId, t.entityType, t.internalId),
    uniqueIndex("uq_map_ext").on(t.organizationId, t.integrationId, t.entityType, t.externalId),
  ],
);

// ────────────────────────────────────────────────────────────
// 通知（§2.4 / §2.5）
// ────────────────────────────────────────────────────────────

/**
 * Web Push の購読（§2.4）。
 *
 * iOS はホーム画面に追加された PWA でしか受信できない（§5.2 / ui-writing.md §6）。
 * `isStandalone` が偽の購読へ送らず `IN_APP` へ落とす。**通知が届かなくても
 * 全業務が成立する**ことが前提なので、この表が空でも何も止まらない。
 *
 * `p256dh` / `auth` は購読者の公開鍵と認証シークレット。**これは外部システムへの
 * ログイン情報ではなく、端末が発行した宛先の一部**なので KV へ出さない。
 * 漏れて起きるのは「その端末へ通知を送れる」ことで、`credentialRef` の
 * 扱いとは危険度が違う（DECISIONS #138）。
 */
export const pushSubscription = sqliteTable(
  "push_subscription",
  {
    ...primaryId,
    ...tenantColumn,
    membershipId: text("membership_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    /** ホーム画面に追加された PWA からの購読か。**登録時に判定して記録する**（§5.2 MUST）。 */
    isStandalone: integer("is_standalone", { mode: "boolean" }).notNull().default(false),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    /** 3 で購読を無効化する（§5.2 MUST）。 */
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("uq_push").on(t.organizationId, t.membershipId, t.endpoint)],
);

/**
 * 利用者ごとの通知設定（§2.5）。
 *
 * **行が無いことが「既定のまま」を表す。** 全員ぶんを事前に作らない。
 * 既定チャネルは §5.1 の表で、配信側（P6-09）が持つ。
 */
export const notificationPreference = sqliteTable(
  "notification_preference",
  {
    ...primaryId,
    ...tenantColumn,
    membershipId: text("membership_id").notNull(),
    eventCode: text("event_code", { enum: NOTIFICATION_EVENT_CODES }).notNull(),
    channels: text("channels", { mode: "json" })
      .$type<NotificationChannel[]>()
      .notNull()
      .default([]),
    /** `"22:00"`。`null` は既定（22:00-07:00 / §5.3）。 */
    quietHoursFrom: text("quiet_hours_from"),
    /** `"07:00"`。 */
    quietHoursTo: text("quiet_hours_to"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("uq_notif_pref").on(t.organizationId, t.membershipId, t.eventCode)],
);

// ────────────────────────────────────────────────────────────
// 公開 API（§6.1 / §6.4）
// ────────────────────────────────────────────────────────────

/**
 * 公開 API のキー（§6.1）。
 *
 * **平文のキーはどこにも残らない。** 作成時に 1 回だけ呼び出し元へ返し、
 * 表には `keyPrefix`（表示用の先頭）と `keyHash`（全体の SHA-256）だけを置く。
 * 再表示できる実装にしない（§6.1 MUST / security.md §7）。
 *
 * `propertyIds` が `null` なら組織全体、配列なら**その施設だけ**。
 * 空配列は「1 件も見えない」で、`allowedPropertyIds` と同じ扱いにする
 * （DECISIONS #017）。`null` と `[]` を取り違えないこと。
 */
export const apiKey = sqliteTable(
  "api_key",
  {
    ...primaryId,
    ...tenantColumn,
    name: text("name").notNull(),
    /** 表示用の先頭（`pk_live_abcd`）。**これだけでは認証できない。** */
    keyPrefix: text("key_prefix").notNull(),
    /** キー全体の SHA-256（16 進）。**平文は保存しない。** */
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<ApiScope[]>().notNull(),
    /** `null` = 組織全体。配列 = その施設だけ。`[]` = 1 件も見えない。 */
    propertyIds: text("property_ids", { mode: "json" }).$type<string[] | null>(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    /** 失効時刻。**行は消さない**（誰がいつ作って失効させたかを残す）。 */
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdById: text("created_by_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    // **索引の先頭は組織**（schema.spec.ts が全表に課す）。ハッシュだけで
    // 引ける索引にしないのは、16 シャードのどれを引くかを決められないため。
    // 組織はシャードの決定に必要（architecture.md §1）で、全シャード走査は
    // 禁止されている（同 §3）。**Bearer トークンから組織を解決する手段は
    // P6-12 が決める**（docs/OPEN_QUESTIONS.md #086）。
    uniqueIndex("uq_api_key_hash").on(t.organizationId, t.keyHash),
    index("idx_api_key_org").on(t.organizationId, t.revokedAt),
  ],
);

/**
 * ProofKeeping から外部へイベントを送る先（§6.4）。
 *
 * 仕様の `secret`（平文）は `secretRef` に読み替えた（上の注記 ③）。
 * 署名鍵は `CREDENTIALS` KV に暗号化して置く。
 *
 * 5 回失敗で `isActive = false` にして管理者へ通知する（§6.4 MUST）。
 */
export const outboundWebhook = sqliteTable(
  "outbound_webhook",
  {
    ...primaryId,
    ...tenantColumn,
    url: text("url").notNull(),
    /** 署名鍵の**参照キー**。実体は `CREDENTIALS` KV（P6-02）。 */
    secretRef: text("secret_ref").notNull(),
    events: text("events", { mode: "json" }).$type<OutboundWebhookEvent[]>().notNull(),
    ...activeFlag,
    /** 5 で無効化する（§6.4 MUST）。成功で 0 に戻す。 */
    failureCount: integer("failure_count").notNull().default(0),
    lastDeliveryAt: integer("last_delivery_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_outbound_webhook").on(t.organizationId, t.isActive)],
);

// ────────────────────────────────────────────────────────────
// 年次アーカイブ（PK-SPEC-P0 §19.7 / P7-08）
// ────────────────────────────────────────────────────────────

/**
 * R2 へ退避した 1 ファイルの記録（§19.7 の手順 2）。
 *
 * **「削除」ではなく「退避」。** P7 固有の絶対ルールで、列名にも
 * 関数名にも `delete` を出さない。退避しても**元の行が消えたことを
 * 記録するのではなく、R2 に写しがあることを記録する**表。
 *
 * ── なぜ `sha256` を持つのか ────────────────────────────
 * §19.7 が「SHA-256 を計算して `archive_manifest` テーブルへ記録」と
 * 定める。**R2 のオブジェクトが後で書き換わっていないこと**を、
 * 復元するとき（P7-09）に確かめられるようにするため。
 * 証跡（`evidence_snapshot`）の `payloadSha256` と同じ役割。
 *
 * ── 何を退避したかを表の名前で持つ ──────────────────────
 * `tableName` は `archivePolicy.ts` の `ARCHIVABLE_TABLES` の値。
 * **語彙で縛らない**（`text` のまま）のは、退避した当時に存在した表の
 * 名前を残すため。将来その表が消えても、この行は「2025 年に
 * `linen_record` を退避した」という事実を保つ。
 *
 * ── 一意にするもの ──────────────────────────────────────
 * 組織 × 年 × 表で 1 行。**同じ年を 2 回退避しても行が増えない**
 * （2 回目は上書き / testing.md §4 の冪等）。
 */
export const archiveManifest = sqliteTable(
  "archive_manifest",
  {
    ...primaryId,
    ...tenantColumn,
    /** 退避した年（西暦）。 */
    year: integer("year").notNull(),
    /** 退避した表の名前（`ARCHIVABLE_TABLES` の値）。 */
    tableName: text("table_name").notNull(),
    /** R2 のキー（`archive/{orgId}/{year}/{table}.jsonl.gz`）。 */
    objectKey: text("object_key").notNull(),
    /** 書き出した行数。**0 でも記録する**（「その年は無かった」も事実）。 */
    rowCount: integer("row_count").notNull(),
    /** 圧縮前の JSONL の SHA-256（16 進 64 桁）。 */
    sha256: text("sha256").notNull(),
    /** 圧縮後のバイト数。 */
    sizeBytes: integer("size_bytes").notNull(),
    /** 退避した業務日の上限（この日より前を退避した）。 */
    cutoffBusinessDate: text("cutoff_business_date").notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_archive_manifest").on(t.organizationId, t.year, t.tableName),
    index("idx_archive_manifest").on(t.organizationId, t.archivedAt),
  ],
);

/**
 * 退避データの復元リクエスト（PK-SPEC-P7 §9 / P7-09）。
 *
 * ── 「削除」ではなく「退避」──────────────────────────────
 * P7 固有の絶対ルール。**この表に `deleted` を含む列を作らない。**
 * 退避したデータは R2 に在り続け、ここは「一時的に読める形へ戻した」
 * ことだけを記録する。期限が来て消えるのは**復元した写し**であって、
 * 退避そのものではない（`archiveManifest` の行は残る）。
 *
 * ── 同時実行は組織あたり 1 件（§9.2）────────────────────
 * **部分 index で強制できない**（SQLite の UNIQUE は NULL を別値として
 * 扱い、状態列での絞り込みも書けない）。作成側
 * （`repositories/archiveRestore.ts`）が走行中の行を数えて拒む。
 */
export const archiveRestore = sqliteTable(
  "archive_restore",
  {
    ...primaryId,
    ...tenantColumn,
    /** 復元を要求した `membership.id`。 */
    requestedById: text("requested_by_id").notNull(),
    /** 施設で絞る場合のみ。`null` は組織全体（§9.1「期間と施設を指定して」）。 */
    propertyId: text("property_id"),
    /** 復元する業務日の範囲（含む）。**最大 3 か月**（§9.2）。 */
    fromBusinessDate: text("from_business_date").notNull(),
    toBusinessDate: text("to_business_date").notNull(),
    status: text("status", { enum: ARCHIVE_RESTORE_STATUSES }).notNull().default("PENDING"),
    /** 展開した表の数。 */
    tableCount: integer("table_count").notNull().default(0),
    /** 展開した行数。 */
    rowCount: integer("row_count").notNull().default(0),
    /**
     * 閲覧できる期限（§9.2「保持 7 日」）。
     *
     * **`READY` になった時点で決まる。** 要求した時点ではない
     * （待ち行列が長いと閲覧できる時間が削られるため）。
     */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    /** 失敗の理由。**利用者に見せる短い符号**（例外の文面を入れない）。 */
    errorCode: text("error_code"),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("idx_archive_restore").on(t.organizationId, t.requestedAt),
    index("idx_archive_restore_status").on(t.organizationId, t.status),
  ],
);

/**
 * 復元した行の置き場（§9.1 の「一時テーブルへ展開」）。
 *
 * ── 表ごとに列を作らない ────────────────────────────────
 * 退避の対象は 5 表あり、列はそれぞれ違う。**表ごとに復元先を作ると、
 * 元の表のスキーマが変わるたびに復元先も直す必要がある**（そして
 * 直し忘れると古い退避が読めなくなる）。JSONL の 1 行をそのまま
 * `payload` に置き、画面は「列名と値の並び」として出す。
 *
 * ── 元の表へ書き戻さない ────────────────────────────────
 * **復元は閲覧のためであって、復旧ではない。** 元の表へ INSERT すると
 * `cleaning_task` などの現役の表に 13 か月前の行が混ざり、集計と
 * 業務日の前提が崩れる。§9 が「閲覧」と書いているとおりに読む。
 */
export const archiveRestoreRow = sqliteTable(
  "archive_restore_row",
  {
    ...primaryId,
    ...tenantColumn,
    restoreId: text("restore_id").notNull(),
    /** 退避元の表の名前（`DIRECTLY_ARCHIVABLE_TABLES` の値）。 */
    tableName: text("table_name").notNull(),
    /** その行の業務日。**絞り込みと並び替えに使う。** */
    businessDate: text("business_date").notNull(),
    /** JSONL の 1 行そのまま。 */
    payload: text("payload").notNull(),
  },
  (t) => [
    index("idx_archive_restore_row").on(t.organizationId, t.restoreId, t.tableName),
  ],
);
