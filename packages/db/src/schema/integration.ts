/**
 * 外部システムとの ID 対応表。
 *
 * task: docs/tasks/P0-22.md（**定義のみ。使用は P6**）
 * 仕様: docs/PK-SPEC-P0.md §24.4 / docs/PK-SPEC-P6.md §2.3
 *
 * ── なぜ P0 で定義だけ置くのか ──────────────────────────
 * §26 が「P0 では externalMapping テーブルの定義まで」と指定している。
 * 方式B（PMS 連携）の差分承認は P6。**P0 のコードはこの表を読み書きしない。**
 *
 * ── 列は P6 仕様のまま ──────────────────────────────────
 * `integrationId` が指す `integration` 表は P6 が作る。P0 では外部キー制約を
 * 張らない（相手の表がまだ無い）。**この表に業務データを載せないこと。**
 * 持ってよいのは「内部 ID ↔ 外部 ID」の対応だけで、
 * 宿泊者情報は一切置かない（security.md §3）。
 */

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { activeFlag, primaryId, tenantColumn } from "./columns.js";

/** 対応付ける実体の種類（PK-SPEC-P6 §2.3）。 */
export const EXTERNAL_ENTITY_TYPES = ["ROOM", "ROOM_TYPE", "PROPERTY"] as const;

export const externalMapping = sqliteTable(
  "external_mapping",
  {
    ...primaryId,
    ...tenantColumn,
    /** 連携先。`integration` 表は P6 が作る。 */
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
