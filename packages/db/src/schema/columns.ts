/**
 * 全テーブル共通の列規約。
 *
 * task:  docs/tasks/P0-06.md
 * ルール: .claude/rules/architecture.md §2 / §7
 *
 * ── 型の決め方 ──────────────────────────────────────────
 *   時刻    integer + mode:"timestamp_ms"（D1 は SQLite。epoch ミリ秒で持つ）
 *   業務日  text の `YYYY-MM-DD`（architecture.md §7。カレンダー日を使わない）
 *   真偽    integer + mode:"boolean"
 *   金額    integer（円）。浮動小数点を使わない（.claude/rules/billing.md §4）
 *
 * ── organizationId を全テーブルに置く理由 ────────────────
 * 物理的にシャード分離されていても省略しない（PK-SPEC-P0 §19.5）。
 * 将来の再シャーディングと移行の唯一の手がかりになる。
 * リポジトリ層はこの列に必ず `eq()` を張る（同 §19.4 第1層）。
 */

import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * 主キー。形式は `{orgShortId}__{entityPrefix}_{ulid}`（PK-SPEC-P0 §19.4 第2層）。
 * 値は `packages/db/src/id.ts` の `generateId()` が作る。DB 側では検証しない
 * （SQLite の CHECK では ULID の妥当性まで見られないため、入口で弾く）。
 */
export const primaryId = { id: text("id").primaryKey() } as const;

/** テナント識別子。**全業務テーブルに必須。** */
export const tenantColumn = {
  organizationId: text("organization_id").notNull(),
} as const;

/** 作成・更新時刻。更新はリポジトリ層が `ctx.now` で入れる（`Date.now()` を直接使わない）。 */
export const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
} as const;

/**
 * 無効化フラグ。
 *
 * マスタは物理削除しない（PK-SPEC-P0 §24.4 / §26）。過去のタスクと証跡が
 * 参照しているため、`isActive = false` にするだけに留める。
 */
export const activeFlag = {
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
} as const;

/** 一覧の並び順。施設・建物・階・客室タイプで使う。 */
export const sortOrderColumn = {
  sortOrder: integer("sort_order").notNull().default(0),
} as const;
