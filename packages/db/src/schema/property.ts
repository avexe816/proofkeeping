/**
 * 施設・建物・階・客室タイプ・客室のマスタ。
 *
 * task: docs/tasks/P0-06.md
 * 仕様: docs/PK-SPEC-P0.md §23（施設セレクタ）/ §24（客室マスタの 2 方式）
 *
 * ── 物理削除しない ──────────────────────────────────────
 * 客室の物理削除 API を作らない（PK-SPEC-P0 §26）。無効化は `isActive = false`。
 * 過去のタスクと証跡が参照しているため。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import {
  activeFlag,
  primaryId,
  sortOrderColumn,
  tenantColumn,
  timestamps,
} from "./columns.js";

/** 客室の登録経路（PK-SPEC-P0 §24.3）。方式B（PMS 連携）は P6。 */
export const ROOM_SOURCE_TYPES = ["MANUAL", "PMS_SYNC", "CSV"] as const;

/**
 * 客室の清掃ステータス（PK-SPEC-P1 §11.1）。
 *
 * task: docs/tasks/P1-16.md（OPEN_QUESTIONS #034 の解消）
 *
 * タスクの状態（`cleaning_task.status`）とは別物。**タスクは作業の進み、
 * こちらは客室が使える状態か**を表す。1 客室に複数のタスクが立ちうるため
 * 1 対 1 にはならない（同期の規則は `packages/engine` の
 * `housekeepingStatusFor()` が持つ）。
 *
 * **`READY` になるのは検査が終わってから**（§11.1 MUST）。
 */
export const HOUSEKEEPING_STATUSES = [
  "DIRTY",
  "IN_PROGRESS",
  "INSPECTING",
  "READY",
  "BLOCKED",
] as const;

export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

/**
 * 施設。
 *
 * `code` は清掃スタッフのログインで使う施設コード（security.md §2、
 * PK-SPEC-P7 §2.4 のログイン案内カードの `HTLA`）。
 */
export const property = sqliteTable(
  "property",
  {
    ...primaryId,
    ...tenantColumn,
    code: text("code").notNull(),
    name: text("name").notNull(),
    postalCode: text("postal_code"),
    address: text("address"),
    timezone: text("timezone").notNull().default("Asia/Tokyo"),
    /**
     * 日締め時刻 `HH:MM`。既定 05:00 Asia/Tokyo（architecture.md §7）。
     * 全ての日次集計はこれを基準にした `businessDate` で行う。
     */
    dayCutoffTime: text("day_cutoff_time").notNull().default("05:00"),
    /**
     * 検査を要求するか（PK-SPEC-P1 §5.2 の `Property.inspectionRequired`）。
     *
     * `false` なら `complete` が直接 `COMPLETED` へ進む。`true` なら
     * `AWAITING_INSPECTION` で止まる。**既定を `false` にしてある**のは、
     * P1 に検査画面が無く（§1.2 Out of Scope）、既定が `true` だと
     * 全タスクが検査待ちで滞留するため。**この設定自体の変更は
     * `AuditLog` に残す**（§11.1 MUST）。
     */
    inspectionRequired: integer("inspection_required", { mode: "boolean" })
      .notNull()
      .default(false),
    ...sortOrderColumn,
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_property_org_code").on(t.organizationId, t.code),
    index("idx_property_org").on(t.organizationId),
  ],
);

/** 建物（本館・別館など）。CSV 取込の `building_name` に対応する。 */
export const building = sqliteTable(
  "building",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    name: text("name").notNull(),
    ...sortOrderColumn,
    ...activeFlag,
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_building_property_name").on(t.organizationId, t.propertyId, t.name)],
);

/**
 * 階。CSV 取込の `floor_name`（`3F` / `B1`）に対応する。
 *
 * `buildingId` は建物を登録していない施設のために null を許す。
 * SQLite の UNIQUE は NULL 同士を別値として扱うため、この列が null の行は
 * DB では重複を弾けない。同名の重複はリポジトリ層（P0-22）で防ぐ。
 */
export const floor = sqliteTable(
  "floor",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    buildingId: text("building_id"),
    name: text("name").notNull(),
    ...sortOrderColumn,
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_floor_property_building_name").on(
      t.organizationId,
      t.propertyId,
      t.buildingId,
      t.name,
    ),
  ],
);

/**
 * 客室タイプ。CSV 取込の `room_type_code`（`SGL` / `TWN` / `PANTRY`）に対応する。
 *
 * 標準時間（`standardMinutes`）はここに持たない。P1-02 の標準時間マスタが
 * 施設 × 客室タイプ × 作業種別で保持する。
 */
export const roomType = sqliteTable(
  "room_type",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    bedCount: integer("bed_count"),
    capacity: integer("capacity"),
    ...sortOrderColumn,
    ...activeFlag,
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_room_type_property_code").on(t.organizationId, t.propertyId, t.code)],
);

/**
 * 客室。
 *
 * `isSellable` / `sourceType` / `externalRoomId` は PK-SPEC-P0 §24.3 が定めた列。
 * P0-22 の task には「Room に 3 カラムを追加」とあるが、仕様で列が確定しており
 * 後日の ALTER TABLE が無駄になるため初回の CREATE TABLE に含めてある。
 *
 * `isSellable = false` は清掃専用の場所（パントリー・備品庫・大浴場など）。
 *   - 客室ボードでは別セクションに表示し、客室数の集計に含めない
 *   - 稼働照合（P4）の対象外。稼働記録が存在しないのが正常なため
 *   - 方式B（P6）の PMS 差分の対象から除外する
 */
export const room = sqliteTable(
  "room",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    buildingId: text("building_id"),
    floorId: text("floor_id"),
    roomTypeId: text("room_type_id"),
    roomNumber: text("room_number").notNull(),
    /** 既定 true。false は清掃専用の場所（PK-SPEC-P0 §24.3）。 */
    isSellable: integer("is_sellable", { mode: "boolean" }).notNull().default(true),
    /**
     * 清掃ステータス（PK-SPEC-P1 §11.1）。**既定は `DIRTY`。**
     *
     * 既定を `READY` にすると、まだ一度も清掃していない客室が
     * 「清掃済」として盤面に並ぶ。**分からない状態を「終わっている」側へ
     * 倒さない。** 手動上書き（§11.2）は理由必須で `AuditLog` に残る。
     */
    housekeepingStatus: text("housekeeping_status", { enum: HOUSEKEEPING_STATUSES })
      .notNull()
      .default("DIRTY"),
    /** 登録経路。PMS からの取得で既存を自動上書きしない（同 §24.4）。 */
    sourceType: text("source_type", { enum: ROOM_SOURCE_TYPES }).notNull().default("MANUAL"),
    /** PMS 側の ID（方式B・P6 用）。P0 では書き込まない。 */
    externalRoomId: text("external_room_id"),
    note: text("note"),
    ...sortOrderColumn,
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_room_property_number").on(t.organizationId, t.propertyId, t.roomNumber),
    index("idx_room_property_sellable").on(t.organizationId, t.propertyId, t.isSellable),
  ],
);
