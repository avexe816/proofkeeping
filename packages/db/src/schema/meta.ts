/**
 * マイグレーションの適用状態。テナントデータではない。
 *
 * task: docs/tasks/P0-06.md
 * 仕様: docs/PK-SPEC-P0.md §19.8
 *
 * ── drizzle-kit の生成対象に入れない ────────────────────
 * この表は**マイグレーションランナー自身が** `CREATE TABLE IF NOT EXISTS` で作る。
 * 適用済みの記録を読むために、最初の migration を適用する前から存在している
 * 必要があるため。drizzle.config.ts の `schema` にこのファイルを含めると
 * 生成された `CREATE TABLE` と衝突する。
 *
 * 定義をここに置いているのは、起動時ヘルスチェック（P0-20）が型付きで
 * 読めるようにするため。DDL の正は `packages/db/src/migrate.ts` の
 * `SCHEMA_VERSION_DDL` で、両者は同じ形でなければならない。
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const schemaVersion = sqliteTable("schema_version", {
  /** migration のタグ。`0000_p0_initial` のような journal 上の名前。 */
  tag: text("tag").primaryKey(),
  /** 適用した .sql の SHA-256。適用後にファイルを書き換えたら検出できる。 */
  checksum: text("checksum").notNull(),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }).notNull(),
});
