/**
 * drizzle-kit の設定。`pnpm db:generate` が読む。
 *
 * task: docs/tasks/P0-06.md
 *
 * ── 生成するもの ────────────────────────────────────────
 * `packages/db/migrations/NNNN_*.sql` と `meta/_journal.json`。
 * 適用は `pnpm db:migrate`（`packages/db/src/migrate.ts`）が行う。
 * **drizzle-kit の push / migrate は使わない。** 16 シャードへの順次適用と
 * 失敗時の中止（PK-SPEC-P0 §19.8）を自前のランナーが担うため。
 *
 * ── schema に meta.ts を含めない ────────────────────────
 * `schema_version` はランナー自身が `CREATE TABLE IF NOT EXISTS` で作る。
 * ここに含めると生成された `CREATE TABLE` と衝突する。
 *
 * ── global.ts は含める ──────────────────────────────────
 * `org_directory` は SHARD_00 の実体だけを使うが、テーブル定義は全シャードへ流す。
 * SHARD_00 にだけ作ると `schema_version` がシャード間で食い違い、
 * 起動時の不一致検出が正常時に発火する（docs/DECISIONS.md #014）。
 *
 * ── platform.ts も含める ────────────────────────────────
 * `platform_operator` / `platform_audit_log` も SHARD_00 の実体だけを使うが、
 * 定義は全シャードへ流す（global.ts と同じ理由 / DECISIONS #220）。
 *
 * 名前を決めて生成すること: `pnpm db:generate --name p0_initial`
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./packages/db/src/schema/index.ts",
    "./packages/db/src/schema/global.ts",
    "./packages/db/src/schema/platform.ts",
  ],
  out: "./packages/db/migrations",
});
