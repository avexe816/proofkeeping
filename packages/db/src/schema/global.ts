/**
 * 全局（テナント横断）テーブル。**SHARD_00 の実体だけを正とする。**
 *
 * task: docs/tasks/P0-06.md
 * 決定: docs/DECISIONS.md #014
 *
 * ── なぜここだけテナント横断なのか ──────────────────────
 * `orgShortId` は 31 文字 6 桁で 31⁶ ≈ 8.9 億通りしかなく、1 万組織で誕生日衝突が
 * 約 5.6% 起きる（OPEN_QUESTIONS #009）。衝突すると 2 組織の ID が
 * `assertIdBelongsToTenant()` を相互に通過し、**テナント分離の第 2 層が破れる。**
 * 組織は 16 シャードへ分散するため、単一シャードの UNIQUE では全局一意を担保できない。
 * そこで採番のレジストリだけを SHARD_00 に集約し、UNIQUE 制約で担保する。
 *
 * ── 16 シャードすべてに作る ─────────────────────────────
 * 使うのは SHARD_00 の実体だけだが、**テーブル定義は全シャードへ流す。**
 * SHARD_00 にだけ作ると `schema_version` がシャード間で食い違い、
 * 起動時の不一致検出（PK-SPEC-P0 §19.8）が正常時に発火して
 * 書き込み系 API が 503 になる。
 *
 * ── 置いてよいもの ──────────────────────────────────────
 * 採番済みの `orgShortId` と、それが指す `organizationId` だけ。
 * **組織名・連絡先・その他の業務データを置かない。** ここに業務データを足すと
 * 「テナント横断の集計を書かない」（architecture.md §3）が崩れる。
 */

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const orgDirectory = sqliteTable(
  "org_directory",
  {
    /** 採番済みの 6 桁。全局一意はこの主キーが担保する。 */
    orgShortId: text("org_short_id").primaryKey(),
    /** `{orgShortId}__org_{ulid}`。 */
    organizationId: text("organization_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("uq_org_directory_organization").on(t.organizationId)],
);
