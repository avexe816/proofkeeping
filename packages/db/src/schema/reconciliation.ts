/**
 * 稼働照合（3 系統の突き合わせ）の表。
 *
 * task: docs/tasks/P4-01.md
 * 仕様: docs/PK-SPEC-P4.md §2（データモデル）/ §3.1（ルール一覧）/ §4（抑制）
 * ルール: .claude/rules/architecture.md §2 / .claude/rules/security.md §3
 *
 * ── 3 系統 ──────────────────────────────────────────────
 *   A 稼働記録   `occupancySnapshot`（PMS / CSV / 手入力）
 *   B 現場の観察 `roomObservation`（P3。この表は持たない）
 *   C 物理の痕跡 `physicalSignal`（施錠・入退室）
 *
 * **3 つそろわなくても動く**（§1.2）。欠けた系統は
 * `reconciliationRun.availableSources` に出し、要求するルールを飛ばす。
 * 黙って 0 件にしない。
 *
 * ── ここに宿泊者の情報は無い ────────────────────────────
 * `occupancySnapshot` が持つのは**人数と予約参照番号だけ**（§2.1 MUST /
 * security.md §3）。氏名・連絡先・住所・パスポート・カードの列を足さない。
 * 照合はこの 2 つで足りる。`rawPayload` に外部の生データを入れるときも
 * 個人情報はマスクしてから入れること（security.md §3）。
 *
 * ── 「検知」ではなく「照合」 ────────────────────────────
 * 表・列・語彙に「不正」「検知」「監視」「疑わしい」を出さない
 * （§1.1 MUST / ui-writing.md §2）。`auditFinding` は**差異**であって
 * 不正の認定ではない。原因の判断は人間が行う。
 *
 * ── 仕様との差 ──────────────────────────────────────────
 * ① 時刻はすべて `timestamp_ms`。仕様 §2 は `mode: "timestamp"`（秒）と
 *    書くが、既存の全表が `timestamp_ms` で揃っている（columns.ts の列規約）。
 *    P3-01 と同じ判断。
 * ② 一意インデックス・索引の先頭に `organizationId` を足した。仕様の
 *    `uq_occ` / `uq_run` / `uq_finding` は組織をまたいで一意になり、同居する
 *    別組織の行と衝突しうる（architecture.md §2 第1層）。P3-01 と同じ判断。
 * ③ `auditFinding` に `propertyId` に加えて `organizationId` はあるが、仕様の
 *    `runId` だけでは組織が辿れないため索引の先頭に組織を置いた。
 * ④ `occupancySnapshot.source` の `uq_occ` は仕様どおり `roomId` 基準。
 *    **同じ客室・同じ業務日でも取込元が違えば別行**（PMS と CSV の食い違いを
 *    潰さずに残す）。どちらを採るかは照合側が決める。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn } from "./columns.js";

// ────────────────────────────────────────────────────────────
// 語彙（PK-SPEC-P4 §2）
// ────────────────────────────────────────────────────────────

/** 稼働記録の取込元（§2.1）。 */
export const OCCUPANCY_SOURCES = ["PMS_API", "CSV_IMPORT", "MANUAL"] as const;

export type OccupancySource = (typeof OCCUPANCY_SOURCES)[number];

/** 販売経路（§2.1 の `channelCode`）。 */
export const OCCUPANCY_CHANNEL_CODES = ["OTA", "DIRECT", "WALK_IN"] as const;

export type OccupancyChannelCode = (typeof OCCUPANCY_CHANNEL_CODES)[number];

/**
 * 物理シグナルの種類（§2.2）。
 *
 * **増やすときは照合ルール側と一緒に決めること。** ここだけ足しても
 * どのルールも読まない。
 */
export const SIGNAL_TYPES = [
  "DOOR_UNLOCK",
  "DOOR_OPEN",
  "KEY_ISSUE",
  "POWER_ON",
  "WIFI_JOIN",
  "SELF_CHECKIN",
  "SAFE_USE",
  "MINIBAR_SENSOR",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

/**
 * シグナルを発生させた鍵の種別（§2.2 の `actorType`）。
 *
 * `STAFF_KEY` / `MASTER_KEY` は業務上の入室で、R002 の除外に使う
 * （§3.3）。分からないときは `UNKNOWN`。**推測で埋めない。**
 */
export const SIGNAL_ACTOR_TYPES = [
  "GUEST_KEY",
  "STAFF_KEY",
  "MASTER_KEY",
  "MOBILE_KEY",
  "UNKNOWN",
] as const;

export type SignalActorType = (typeof SIGNAL_ACTOR_TYPES)[number];

/** 正当な入室の目的（§2.3）。 */
export const ROOM_ACCESS_PURPOSES = [
  "INSPECTION",
  "MAINTENANCE",
  "VENDOR_VISIT",
  "SHOWING",
  "TRAINING",
  "OTHER",
] as const;

export type RoomAccessPurpose = (typeof ROOM_ACCESS_PURPOSES)[number];

/** 照合実行の状態（§2.4）。 */
export const RECONCILIATION_RUN_STATUSES = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
] as const;

export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

/**
 * 3 系統の識別子（§2.4 の `availableSources`）。
 *
 * 仕様の例は `["occupancy","observation","signal"]`。**小文字のまま使う。**
 * 画面と API の応答にそのまま出る値なので、表記を変えない。
 */
export const RECONCILIATION_SOURCES = ["occupancy", "observation", "signal"] as const;

export type ReconciliationSource = (typeof RECONCILIATION_SOURCES)[number];

/**
 * 検出ルールのコード（§3.1）。
 *
 * **14 個で閉じている。** 顧客が独自ルールを定義できるようにするかは
 * §13 の未決事項で、v2 以降。ここを可変にしない。
 *
 * 実装済みのルールは `packages/engine` の registry が持つ。この一覧は
 * 「`ruleConfig` に置いてよいコード」であって「動くルール」ではない。
 */
export const RULE_CODES = [
  "R001",
  "R002",
  "R003",
  "R004",
  "R005",
  "R006",
  "R007",
  "R008",
  "R009",
  "R010",
  "R011",
  "R012",
  "R013",
  "R014",
] as const;

export type RuleCode = (typeof RULE_CODES)[number];

/** 差異の重要度（§2.5）。§4.2 の引き下げは HIGH → MEDIUM → LOW の 1 段階ずつ。 */
export const FINDING_SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * 差異の状態（§2.5）。
 *
 * `FALSE_POSITIVE` は**誤検知として閉じた**の意で、UI にこの語を出さない
 * （§6.3 の解決コードを表示する）。`SUPPRESSED` は §4.1 で抑制した差異。
 */
export const FINDING_STATUSES = [
  "OPEN",
  "REVIEWING",
  "RESOLVED",
  "FALSE_POSITIVE",
  "SUPPRESSED",
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** 誤検知学習の結果（§2.6）。§4.2 が直近 30 日の `FALSE_POSITIVE` を数える。 */
export const DETECTION_OUTCOMES = ["TRUE_POSITIVE", "FALSE_POSITIVE"] as const;

export type DetectionOutcome = (typeof DETECTION_OUTCOMES)[number];

// ────────────────────────────────────────────────────────────
// 表
// ────────────────────────────────────────────────────────────

/**
 * A 系統 — 稼働記録（§2.1）。
 *
 * **氏名・連絡先を持たない**（§2.1 MUST）。照合に要るのは
 * `isOccupied` / `guestCount` / `reservationRef` だけ。
 *
 * 同じ客室・業務日でも `source` が違えば別行として残す（`uq_occ`）。
 * PMS と CSV が食い違ったとき、どちらかを消すと差異の根拠が消える。
 */
export const occupancySnapshot = sqliteTable(
  "occupancy_snapshot",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    roomId: text("room_id").notNull(),
    businessDate: text("business_date").notNull(),

    source: text("source", { enum: OCCUPANCY_SOURCES }).notNull(),
    isOccupied: integer("is_occupied", { mode: "boolean" }).notNull(),
    guestCount: integer("guest_count").notNull().default(0),
    adultCount: integer("adult_count").notNull().default(0),
    childCount: integer("child_count").notNull().default(0),
    /** 予約番号のみ。**予約者の氏名を入れないこと**（§2.1 MUST）。 */
    reservationRef: text("reservation_ref"),
    channelCode: text("channel_code", { enum: OCCUPANCY_CHANNEL_CODES }),
    checkInAt: integer("check_in_at", { mode: "timestamp_ms" }),
    checkOutAt: integer("check_out_at", { mode: "timestamp_ms" }),
    isStayover: integer("is_stayover", { mode: "boolean" }).notNull().default(false),
    nightsTotal: integer("nights_total"),
    /** 何泊目か。1 始まり。 */
    nightIndex: integer("night_index"),
    ratePlanCode: text("rate_plan_code"),
    /** 招待・無償。R001 の抑制条件（§4.1）。 */
    isComplimentary: integer("is_complimentary", { mode: "boolean" }).notNull().default(false),
    /** 自社利用。同じく R001 の抑制条件（§4.1）。 */
    isHouseUse: integer("is_house_use", { mode: "boolean" }).notNull().default(false),

    /**
     * 取込元の生データ。**個人情報はマスクしてから入れること**
     * （security.md §3。同期ログの `rawSample` と同じ扱い）。
     */
    rawPayload: text("raw_payload", { mode: "json" }).$type<Record<string, unknown>>(),
    importedAt: integer("imported_at", { mode: "timestamp_ms" }).notNull(),
    /** 取込を実行した `membership.id`。PMS 連携の自動取込では null。 */
    importedById: text("imported_by_id"),
  },
  (t) => [
    uniqueIndex("uq_occ").on(t.organizationId, t.roomId, t.businessDate, t.source),
    index("idx_occ_prop_date").on(t.organizationId, t.propertyId, t.businessDate),
  ],
);

/**
 * C 系統 — 物理の痕跡（§2.2）。
 *
 * 施錠解除・入退室・電源など。**外部機器からの受信のみで、人が入力しない。**
 * 受信は 200 を即返して Queue へ流す（security.md §7）。
 *
 * この表を UPDATE しない。機器が同じ事象を再送したら行が増えるが、
 * 照合側が `(roomId, businessDate, signalType, occurredAt)` で畳む。
 */
export const physicalSignal = sqliteTable(
  "physical_signal",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    roomId: text("room_id").notNull(),
    businessDate: text("business_date").notNull(),

    signalType: text("signal_type", { enum: SIGNAL_TYPES }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    actorType: text("actor_type", { enum: SIGNAL_ACTOR_TYPES }),
    /** 鍵・端末の識別子。**個人名を入れない**（security.md §3）。 */
    actorRef: text("actor_ref"),
    deviceId: text("device_id"),
    rawPayload: text("raw_payload", { mode: "json" }).$type<Record<string, unknown>>(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_sig_room_date").on(
      t.organizationId,
      t.roomId,
      t.businessDate,
      t.signalType,
    ),
    index("idx_sig_time").on(t.organizationId, t.propertyId, t.occurredAt),
  ],
);

/**
 * 正当な入室の記録（§2.3）。
 *
 * **誤検知を減らすための表。** 点検・修繕・内覧・業者立入を事前または事後に
 * 登録しておくと、その客室・業務日の差異を抑制する（§4.1）。
 *
 * `actorName` は立ち入った担当者の名前で、**宿泊者ではない**。従業員の
 * 記録として扱う（security.md §5。個人の評価に使わない）。
 */
export const roomAccessLog = sqliteTable(
  "room_access_log",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    roomId: text("room_id").notNull(),
    businessDate: text("business_date").notNull(),
    purpose: text("purpose", { enum: ROOM_ACCESS_PURPOSES }).notNull(),
    enteredAt: integer("entered_at", { mode: "timestamp_ms" }).notNull(),
    exitedAt: integer("exited_at", { mode: "timestamp_ms" }),
    /** 立ち入った人の `membership.id`。外部業者なら null。 */
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    note: text("note"),
    registeredById: text("registered_by_id").notNull(),
    registeredAt: integer("registered_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_access").on(t.organizationId, t.roomId, t.businessDate)],
);

/**
 * 照合の実行記録（§2.4）。
 *
 * `engineVersion` が同じ再実行は**差分のみ追加**（§5.3 MUST）。既存の
 * Finding を削除しない。`engineVersion` が違えば新しい Run になる。
 *
 * `findingsSuppressed` は §4.3 の「抑制された差異 N 件」の元。
 * **抑制を沈黙させず、件数で見せる。**
 */
export const reconciliationRun = sqliteTable(
  "reconciliation_run",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    businessDate: text("business_date").notNull(),
    engineVersion: text("engine_version").notNull(),
    /** 適用した `ruleConfig` の内容から作る指紋。設定変更を後から追える。 */
    rulesetHash: text("ruleset_hash").notNull(),

    status: text("status", { enum: RECONCILIATION_RUN_STATUSES }).notNull(),
    roomsEvaluated: integer("rooms_evaluated").notNull().default(0),
    rulesEvaluated: integer("rules_evaluated").notNull().default(0),
    findingsCreated: integer("findings_created").notNull().default(0),
    findingsSuppressed: integer("findings_suppressed").notNull().default(0),

    /** 揃っていた系統（§1.2）。欠けたものは画面に「データなし」と出す。 */
    availableSources: text("available_sources", { mode: "json" })
      .$type<ReconciliationSource[]>()
      .notNull(),
    skipReason: text("skip_reason"),
    errorMessage: text("error_message"),

    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("uq_run").on(
      t.organizationId,
      t.propertyId,
      t.businessDate,
      t.engineVersion,
    ),
    index("idx_run_property").on(t.organizationId, t.propertyId, t.businessDate),
  ],
);

/**
 * 差異（§2.5）。**不正の認定ではない**（§1.1 MUST）。
 *
 * `uq_finding` が冪等性の要（§10.2）。同じ客室・業務日・ルールで 2 行作らない。
 * 再実行で既存行に当たったら**触らない**。ステータスを変更済みの行を
 * 上書きすると、人が付けた判断が消える（§5.3 MUST）。
 *
 * `CLEANER` / `INSPECTOR` はこの表に到達できない。API は 404 を返す
 * （§6.4 / security.md §1。403 は存在を示唆する）。
 */
export const auditFinding = sqliteTable(
  "audit_finding",
  {
    ...primaryId,
    ...tenantColumn,
    runId: text("run_id").notNull(),
    propertyId: text("property_id").notNull(),
    roomId: text("room_id").notNull(),
    businessDate: text("business_date").notNull(),

    ruleCode: text("rule_code", { enum: RULE_CODES }).notNull(),
    ruleVersion: text("rule_version").notNull(),
    severity: text("severity", { enum: FINDING_SEVERITIES }).notNull(),
    /** 0〜100。**単一シグナルで 80 以上を出さない**（§1.3 / P4 固有ルール）。 */
    confidence: integer("confidence").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),

    /** 3 系統の根拠。差異詳細画面（W-07）がそのまま出す（§6.2）。 */
    evidence: text("evidence", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    matchedSignals: text("matched_signals", { mode: "json" })
      .$type<string[]>()
      .notNull(),

    status: text("status", { enum: FINDING_STATUSES }).notNull().default("OPEN"),
    assignedToId: text("assigned_to_id"),
    resolvedById: text("resolved_by_id"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    /** §6.3 の解決コード。語彙は画面を作る P4-07 が決める。 */
    resolutionCode: text("resolution_code"),
    resolutionNote: text("resolution_note"),

    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_finding").on(
      t.organizationId,
      t.roomId,
      t.businessDate,
      t.ruleCode,
    ),
    index("idx_finding_status").on(
      t.organizationId,
      t.propertyId,
      t.status,
      t.severity,
    ),
    index("idx_finding_date").on(t.organizationId, t.businessDate),
    index("idx_finding_run").on(t.organizationId, t.runId),
  ],
);

/**
 * 誤検知の学習（§2.6 / §1.4）。
 *
 * 同一客室・同一ルールで直近 30 日に `FALSE_POSITIVE` が 3 回以上あれば
 * 重要度を 1 段階下げる（§4.2）。**同じ指摘を繰り返して信頼を失わないため。**
 *
 * 追記のみ。取り消したいときは反対の `outcome` を足す。
 */
export const detectionFeedback = sqliteTable(
  "detection_feedback",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    /** 施設全体の傾向として記録するときは null。 */
    roomId: text("room_id"),
    ruleCode: text("rule_code", { enum: RULE_CODES }).notNull(),
    outcome: text("outcome", { enum: DETECTION_OUTCOMES }).notNull(),
    /** §6.3 の解決コードを写す。集計で「何が原因の誤検知か」を見る。 */
    reasonCode: text("reason_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_feedback").on(
      t.organizationId,
      t.propertyId,
      t.ruleCode,
      t.createdAt,
    ),
  ],
);

/**
 * ルールの施設別設定（§2.7）。
 *
 * `propertyId` が null なら組織の既定。施設の行があればそちらが優先。
 * **engine 側を書き換えずに調整できるようにするための表**（§11 のリスク
 * 「ルール調整が属人化」への対策）。
 *
 * `thresholds` の中身はルールごとに違う。**engine が知っている形だけを
 * 入れること。** 知らない鍵を入れても無視される。
 */
export const ruleConfig = sqliteTable(
  "rule_config",
  {
    ...primaryId,
    ...tenantColumn,
    /** null = 組織既定。 */
    propertyId: text("property_id"),
    ruleCode: text("rule_code", { enum: RULE_CODES }).notNull(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    severityOverride: text("severity_override", { enum: FINDING_SEVERITIES }),
    thresholds: text("thresholds", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_rule_cfg").on(t.organizationId, t.propertyId, t.ruleCode),
  ],
);
