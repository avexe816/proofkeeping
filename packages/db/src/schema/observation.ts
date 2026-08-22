/**
 * 入室時の観察記録・リネン記録・消耗ベースライン。
 *
 * task: docs/tasks/P3-01.md
 * 仕様: docs/PK-SPEC-P3.md §2（データモデル）/ §5.3（外れ値の除外）
 * ルール: .claude/rules/architecture.md §2 / .claude/rules/security.md §3
 *
 * ── ここに宿泊者の情報は無い ────────────────────────────
 * 観察記録が持つのは**清掃員が目で見た数**だけ（§1.1）。氏名・連絡先・
 * 予約者情報を持つ列を足さないこと（security.md §3）。人数は
 * `dailyRoomPlan.guestCount` を参照するだけで、この表には持たない。
 *
 * ── P3 は判定しない ─────────────────────────────────────
 * 「異常」「疑い」を表す列を作らない（§0.2）。ベースラインは統計量であって
 * 判定ではなく、閾値との突き合わせは P4 が行う。
 *
 * ── 仕様との差 ──────────────────────────────────────────
 * ① 時刻はすべて `timestamp_ms`。仕様 §2 は `mode: "timestamp"`（秒）と
 *    書くが、既存の全表が `timestamp_ms` で揃っている（columns.ts の列規約）。
 *    混在させると `ctx.now` を渡す側が表ごとに単位を変えることになる。
 * ② 一意インデックス・索引の先頭に `organizationId` を足した。仕様の
 *    `uniqueIndex("uq_obs_task").on(t.taskId)` は組織をまたいで一意になり、
 *    同居する別組織の行と衝突しうる（architecture.md §2 第1層）。
 * ③ `observationConfig.propertyId` の `.unique()` も同じ理由で
 *    `(organizationId, propertyId)` の複合にした。
 * ④ `observationRevision` / `baselineExclusionLog` に `organizationId` を
 *    足した。親を辿らないと組織が分からない表を作らないため
 *    （inspection.ts と同じ判断）。
 */

import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn, timestamps } from "./columns.js";
import { TASK_TYPES } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙（PK-SPEC-P3 §2.1 / §2.5 / §5.3）
// ────────────────────────────────────────────────────────────

/**
 * ゴミの量（§2.1 の `trashLevel`）。
 *
 * **段階を増やさないこと。** 4 段階なのは「なし／少ない／通常／多い」が
 * 見ただけで答えられる粒度だから（§1.1）。細かくすると判断が要る。
 */
export const TRASH_LEVELS = ["NONE", "LOW", "NORMAL", "HIGH"] as const;

export type TrashLevel = (typeof TRASH_LEVELS)[number];

/** リネンの品目コード（§2.5）。 */
export const LINEN_ITEM_CODES = [
  "SHEET_SINGLE",
  "SHEET_DOUBLE",
  "DUVET_COVER",
  "PILLOW_CASE",
  "BATH_TOWEL",
  "FACE_TOWEL",
  "HAND_TOWEL",
  "BATH_MAT",
  "YUKATA",
  /**
   * 追加布団（P4 の精度向上 / DECISIONS #252）。値は
   * `roomObservation.extra_futon_used` 列から来る（`BATH_TOWEL` と同じ形）。
   *
   * **除外ルール①の対象にしない。** ほとんどの宿泊で使われず、0 が通常の
   * 状態。除外すると母数が「使った回」だけになり、ベースラインが跳ね上がる。
   */
  "EXTRA_FUTON",
] as const;

/** アメニティの品目コード（§2.5）。 */
export const AMENITY_ITEM_CODES = [
  "TOOTHBRUSH",
  "RAZOR",
  "SHAMPOO",
  "CONDITIONER",
  "BODY_SOAP",
  "HAIR_BRUSH",
  "COTTON_SET",
  "SLIPPERS",
  "BOTTLED_WATER",
  "TEA_BAG",
  /**
   * コップ（P4 の精度向上 / DECISIONS #252）。値は
   * `roomObservation.cups_used` 列から来る（`SLIPPERS` と同じ形で、
   * `amenitiesUsed` の JSON は経由しない）。
   */
  "CUP",
] as const;

/**
 * 品目コード（§2.5）。**一度使ったコードを変えないこと。**
 * 過去の `linenRecord` / `consumptionBaseline` の行が読めなくなる。
 *
 * 施設ごとの有効・無効は `observationConfig.enabledItemCodes` で決める
 * （§2.5 MUST。使わない品目を入力画面に出さない）。
 */
export const ITEM_CODES = [...LINEN_ITEM_CODES, ...AMENITY_ITEM_CODES] as const;

export type ItemCode = (typeof ITEM_CODES)[number];

/**
 * ベースライン集計から除外した理由（§5.3）。
 *
 * **仕様は理由の語彙を定めていない。** 除外率を管理画面で見るには
 * 理由ごとの内訳が要るため、§5.3 の 4 ルールに 1 対 1 で対応する
 * コードを置いた（docs/DECISIONS.md #093）。
 *
 *   ZERO_WITH_BEDS_USED  値が 0 かつ bedsUsed > 0（入力漏れ）
 *   OVER_MEDIAN_5X       値が中央値の 5 倍超（誤入力）
 *   INPUT_TOO_FAST       inputDurationMs < 3000（3 秒未満の確定）
 *   REPEATED_INPUT       同一スタッフが同日に 10 件以上同じ値
 *   FINDING_ATTACHED     P4 で差異が付いた日（§5.2 の 1. 除外）
 */
export const BASELINE_EXCLUSION_REASONS = [
  "ZERO_WITH_BEDS_USED",
  "OVER_MEDIAN_5X",
  "INPUT_TOO_FAST",
  "REPEATED_INPUT",
  "FINDING_ATTACHED",
] as const;

export type BaselineExclusionReason = (typeof BASELINE_EXCLUSION_REASONS)[number];

// ────────────────────────────────────────────────────────────
// 表
// ────────────────────────────────────────────────────────────

/**
 * 入室時の観察記録（§2.1）。**すべて清掃前の状態。**
 *
 * 1 タスク 1 行（`uq_obs_task`）。上書きは許すが、旧値を
 * `observationRevision` に残す（§2.2）。
 *
 * `usedDefaults` と `inputDurationMs` は UX の計測用（§3.3 / §4.1）。
 * **個人の評価に使わない**（security.md §5）。既定値のまま確定した比率が
 * 高い施設は入力が形骸化している可能性があり、W-22 が施設単位で警告する。
 */
export const roomObservation = sqliteTable(
  "room_observation",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    taskId: text("task_id").notNull(),
    roomId: text("room_id").notNull(),
    roomTypeId: text("room_type_id").notNull(),
    businessDate: text("business_date").notNull(),

    bedsUsed: integer("beds_used").notNull().default(0),
    trashLevel: text("trash_level", { enum: TRASH_LEVELS }).notNull().default("NONE"),
    bathTowelUsed: integer("bath_towel_used").notNull().default(0),
    faceTowelUsed: integer("face_towel_used").notNull().default(0),
    handTowelUsed: integer("hand_towel_used").notNull().default(0),
    bathMatUsed: integer("bath_mat_used").notNull().default(0),
    slippersUsed: integer("slippers_used").notNull().default(0),
    cupsUsed: integer("cups_used").notNull().default(0),
    extraFutonUsed: integer("extra_futon_used").notNull().default(0),

    /** 品目コード → 個数または使用の有無（§2.1）。画面は §2.6 の設定で決まる。 */
    amenitiesUsed: text("amenities_used", { mode: "json" })
      .$type<Record<string, number | boolean>>()
      .notNull()
      .default({}),

    note: text("note"),
    /** 画面表示から確定までの実測（§4.1）。中央値 20 秒以内が出荷判定（§0.3）。 */
    inputDurationMs: integer("input_duration_ms"),
    usedDefaults: integer("used_defaults", { mode: "boolean" }).notNull().default(false),

    /** 記録者の `membership.id`。 */
    recordedById: text("recorded_by_id").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
    /** 端末側の時刻。**参考値**（オフラインで溜めた分の目安）。 */
    clientTs: integer("client_ts", { mode: "timestamp_ms" }),
    deviceInfo: text("device_info", { mode: "json" }).$type<Record<string, string>>(),
    /** 再送の重複を弾く鍵（§7 MUST。オフラインキューからの再送）。 */
    idempotencyKey: text("idempotency_key"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_obs_task").on(t.organizationId, t.taskId),
    uniqueIndex("uq_obs_idempotency").on(t.organizationId, t.idempotencyKey),
    index("idx_obs_room_date").on(t.organizationId, t.roomId, t.businessDate),
    index("idx_obs_baseline").on(
      t.organizationId,
      t.propertyId,
      t.roomTypeId,
      t.businessDate,
    ),
  ],
);

/**
 * 観察記録の事後修正の履歴（§2.2）。
 *
 * `payload` は**変更前の全内容**。修正は `PROPERTY_MANAGER` 以上のみ・
 * 理由必須（P3-07）。P4 の照合は最新値を使い、差異詳細画面が履歴を出す。
 *
 * **この表を UPDATE / DELETE しないこと。** 追記のみ。
 */
export const observationRevision = sqliteTable(
  "observation_revision",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    observationId: text("observation_id").notNull(),
    /** 1 から始まる連番。 */
    revision: integer("revision").notNull(),
    /** 変更前の全内容（JSON 文字列）。 */
    payload: text("payload").notNull(),
    changedById: text("changed_by_id").notNull(),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
    /** §2.2 MUST「理由必須」。契約側（Zod）で空文字を弾く。 */
    reason: text("reason").notNull(),
  },
  (t) => [
    uniqueIndex("uq_obs_rev").on(t.organizationId, t.observationId, t.revision),
    index("idx_obs_rev_property").on(t.organizationId, t.propertyId, t.changedAt),
  ],
);

/**
 * 退室前のリネン枚数（§2.3）。
 *
 * **枚数であって金額ではない**（§1.4）。在庫・原価は P5 以降の範囲。
 * 破損・汚損は P5 の請求根拠になるため写真 1 枚を求める（§4.3 MUST）。
 */
export const linenRecord = sqliteTable(
  "linen_record",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    taskId: text("task_id").notNull(),
    roomId: text("room_id").notNull(),
    businessDate: text("business_date").notNull(),
    itemCode: text("item_code", { enum: ITEM_CODES }).notNull(),
    collectedQty: integer("collected_qty").notNull().default(0),
    suppliedQty: integer("supplied_qty").notNull().default(0),
    damagedQty: integer("damaged_qty").notNull().default(0),
    stainedQty: integer("stained_qty").notNull().default(0),
    note: text("note"),
    recordedById: text("recorded_by_id").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_linen").on(t.organizationId, t.taskId, t.itemCode),
    index("idx_linen_date").on(t.organizationId, t.propertyId, t.businessDate),
  ],
);

/**
 * 消耗のベースライン（§2.4）。**週次バッチが再計算方式で書く**（P3-09）。
 *
 * `sampleSize < 20` なら `isReliable = false`。**P4 のルール評価から
 * 除外する**（§2.4 MUST）。ここを緩めると、根拠の薄い統計で差異が出る。
 *
 * `manualOverride` は `ORG_ADMIN` が上書きした p90（§5.5）。
 * **次回の自動算出で消さないこと。** 解除するまで固定される。
 */
export const consumptionBaseline = sqliteTable(
  "consumption_baseline",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    roomTypeId: text("room_type_id").notNull(),
    /** 0, 1, 2, 3…。`dailyRoomPlan.guestCount`。 */
    guestCount: integer("guest_count").notNull(),
    /** §2.4 は CHECKOUT / STAYOVER。語彙は `TASK_TYPES` を共有する。 */
    taskType: text("task_type", { enum: TASK_TYPES }).notNull(),
    itemCode: text("item_code", { enum: ITEM_CODES }).notNull(),

    sampleSize: integer("sample_size").notNull(),
    /** 統計量は小数。**金額ではないので real でよい**（billing.md §4 の対象外）。 */
    medianQty: real("median_qty").notNull(),
    p10Qty: real("p10_qty").notNull(),
    p90Qty: real("p90_qty").notNull(),
    maxQty: real("max_qty").notNull(),
    stdDev: real("std_dev").notNull(),

    isReliable: integer("is_reliable", { mode: "boolean" }).notNull().default(false),
    /** 集計ウィンドウ（§5.4）。`YYYY-MM-DD`。 */
    computedFrom: text("computed_from").notNull(),
    computedTo: text("computed_to").notNull(),
    manualOverride: real("manual_override"),
    overrideReason: text("override_reason"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_baseline").on(
      t.organizationId,
      t.propertyId,
      t.roomTypeId,
      t.guestCount,
      t.taskType,
      t.itemCode,
    ),
    index("idx_baseline_property").on(t.organizationId, t.propertyId, t.roomTypeId),
  ],
);

/**
 * 施設ごとの観察設定（§2.6）。
 *
 * `require*` は**入力画面に出すか**であって、入力を強制する意味ではない
 * （§1.3。「今回は記録しない」を必ず残す）。
 *
 * `skipWarnThreshold` は未記録率の警告閾値（%）。既定 20（§1.3）。
 */
export const observationConfig = sqliteTable(
  "observation_config",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),

    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    requireBeds: integer("require_beds", { mode: "boolean" }).notNull().default(true),
    requireTrash: integer("require_trash", { mode: "boolean" }).notNull().default(true),
    requireTowels: integer("require_towels", { mode: "boolean" }).notNull().default(true),
    requireAmenities: integer("require_amenities", { mode: "boolean" }).notNull().default(false),
    requireLinen: integer("require_linen", { mode: "boolean" }).notNull().default(false),

    /** 有効な品目コード（§2.5 MUST）。空なら品目の入力を出さない。 */
    enabledItemCodes: text("enabled_item_codes", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),

    skipWarnThreshold: integer("skip_warn_threshold").notNull().default(20),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("uq_observation_config_property").on(t.organizationId, t.propertyId)],
);

/**
 * ベースライン集計から除外した観察の記録（§5.3 MUST）。
 *
 * **仕様は列を定めていない**（表の名前だけが出てくる）。除外率を
 * 施設ごとに出し（W-22）、除外された行を追えるだけの列を置いた
 * （docs/DECISIONS.md #093）。
 *
 * 再計算方式のバッチが毎回書き直すため、**同じ `computedTo` の行を
 * 消してから入れ直す**（P3-09）。インクリメントしない。
 */
export const baselineExclusionLog = sqliteTable(
  "baseline_exclusion_log",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    /** 除外された観察記録。 */
    observationId: text("observation_id").notNull(),
    businessDate: text("business_date").notNull(),
    roomTypeId: text("room_type_id").notNull(),
    guestCount: integer("guest_count").notNull(),
    taskType: text("task_type", { enum: TASK_TYPES }).notNull(),
    itemCode: text("item_code", { enum: ITEM_CODES }).notNull(),
    reason: text("reason", { enum: BASELINE_EXCLUSION_REASONS }).notNull(),
    /** 除外された値。誤入力の内訳を見るために残す。 */
    qty: real("qty").notNull(),
    /** どの集計実行で除外されたか（§5.4 のウィンドウ終端）。 */
    computedTo: text("computed_to").notNull(),
    excludedAt: integer("excluded_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_baseline_exclusion").on(t.organizationId, t.propertyId, t.computedTo),
    index("idx_baseline_exclusion_obs").on(t.organizationId, t.observationId),
  ],
);
