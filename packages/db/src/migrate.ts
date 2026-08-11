/**
 * マイグレーションランナー。16 シャードへ順次適用する。
 *
 * task: docs/tasks/P0-06.md
 * 仕様: docs/PK-SPEC-P0.md §19.8
 * ルール: .claude/rules/architecture.md §6
 *
 * ── ファイル名を変えないこと ────────────────────────────
 * このパスは ESLint の `no-direct-shard-access` / `no-raw-drizzle` の
 * allowlist に書かれている（docs/DECISIONS.md #009）。改名すると lint が落ちる。
 *
 * ── ここに I/O を持ち込まない ───────────────────────────
 * `packages/db` は Workers ランタイムの型で検査する（node 型を持たない）。
 * `node:fs` / `node:child_process` はアダプタ `scripts/db-migrate.ts` が持ち、
 * 本ファイルは注入された `query` / `execute` だけを使う。
 * その結果、適用計画のすべての分岐をテストから決定的に検証できる。
 *
 * ── 設計方針 ────────────────────────────────────────────
 * 1 つでも失敗したら以降のシャードを実行せずに中止する（仕様 §19.8）。
 * 部分適用は避けられない（シャードをまたぐトランザクションは無い）ので、
 * **どこまで進んだかを必ず出力する。** 黙って次のシャードへ進むと、
 * 半分だけ新しいスキーマという状態が無警告で残る。
 *
 * 適用済みの記録は各シャードの `schema_version` に持つ。全シャードで
 * 一致していることを起動時に検証し、不一致なら書き込み系 API を 503 にする
 * （仕様 §19.8。ヘルスチェック本体は P0-20）。
 */

/**
 * `schema_version` の DDL。**ランナー自身が作る。**
 *
 * 最初の migration を適用する前に「適用済みか」を読む必要があるため、
 * drizzle-kit の生成物には含めない（`schema/meta.ts` の注記を参照）。
 * 定義を変えるときは `schema/meta.ts` と揃えること。
 */
export const SCHEMA_VERSION_DDL =
  "CREATE TABLE IF NOT EXISTS schema_version (" +
  "tag TEXT PRIMARY KEY, " +
  "checksum TEXT NOT NULL, " +
  "applied_at INTEGER NOT NULL)";

/** 適用対象のシャード。`databaseName` は wrangler.toml の `database_name`。 */
export interface ShardTarget {
  index: number;
  bindingName: string;
  databaseName: string;
}

/** journal の 1 エントリと、その .sql の中身。 */
export interface MigrationSource {
  /** `0000_p0_initial` のような journal 上の名前。 */
  tag: string;
  sql: string;
}

/** `schema_version` の 1 行。 */
export interface AppliedMigration {
  tag: string;
  checksum: string;
}

/** SQL を投げて結果を読まない。 */
export type SqlExecutor = (target: ShardTarget, sql: string) => Promise<void>;

/** SQL を投げて行を読む。 */
export type SqlQuery = (target: ShardTarget, sql: string) => Promise<AppliedMigration[]>;

export interface MigrateLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface MigrateDeps {
  query: SqlQuery;
  execute: SqlExecutor;
  log: MigrateLogger;
}

export interface MigrateOptions {
  shards: ShardTarget[];
  migrations: MigrationSource[];
  /** 適用時刻。`Date.now()` を直接呼ばない。 */
  now: Date;
  /** true なら書き込まず、未適用と不一致の検出だけを行う。 */
  checkOnly?: boolean;
}

/** シャード 1 つ分の状態。 */
export interface ShardStatus {
  index: number;
  /** 適用済みの最終 tag。1 つも無ければ null。 */
  currentTag: string | null;
  /** 未適用の tag。 */
  pending: string[];
  /** 今回適用した tag。`checkOnly` では常に空。 */
  applied: string[];
}

export interface MigrateResult {
  shards: ShardStatus[];
  /** 全シャードの `currentTag` が一致しているか。 */
  consistent: boolean;
}

/** tag に許す形。SQL へ文字列連結するため、ここで形を閉じる。 */
const TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/;

/** SHA-256 の 16 進表現。 */
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

/**
 * .sql の SHA-256 を 16 進で返す。
 *
 * `crypto.subtle` は Workers と Node の双方の global にある。
 * 適用後にファイルを書き換えた場合、次回の実行で不一致として検出する。
 */
export async function computeChecksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 未適用の migration を求める。
 *
 * 以下は適用せずに投げる。いずれも「気づかずに進む」方が高くつく。
 *   - 適用済みの .sql が書き換えられている（checksum 不一致）
 *   - 適用済みの tag が journal から消えている（ファイル削除・巻き戻し）
 *   - 適用済みより古い tag が未適用で残っている（挿し込み）
 */
export function planPending(
  migrations: ReadonlyArray<MigrationSource & { checksum: string }>,
  applied: readonly AppliedMigration[],
): string[] {
  const appliedByTag = new Map(applied.map((row) => [row.tag, row.checksum]));

  for (const row of applied) {
    if (!migrations.some((m) => m.tag === row.tag)) {
      throw new Error(`MIGRATION_MISSING_LOCALLY:${row.tag}`);
    }
  }

  const pending: string[] = [];
  let sawPending = false;

  for (const migration of migrations) {
    const appliedChecksum = appliedByTag.get(migration.tag);
    if (appliedChecksum === undefined) {
      sawPending = true;
      pending.push(migration.tag);
      continue;
    }
    if (appliedChecksum !== migration.checksum) {
      throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${migration.tag}`);
    }
    if (sawPending) {
      // 未適用の後ろに適用済みが来る = 途中へ挿し込まれた。
      // そのまま流すと適用順が journal と食い違う。
      throw new Error(`MIGRATION_OUT_OF_ORDER:${migration.tag}`);
    }
  }

  return pending;
}

function assertTag(tag: string): void {
  if (!TAG_PATTERN.test(tag)) throw new Error(`MIGRATION_TAG_INVALID:${tag}`);
}

function assertChecksum(tag: string, checksum: string): void {
  if (!CHECKSUM_PATTERN.test(checksum)) throw new Error(`MIGRATION_CHECKSUM_INVALID:${tag}`);
}

/**
 * `schema_version` へ適用を記録する SQL。
 *
 * `wrangler d1 execute` はプレースホルダを取れないため文字列連結になる。
 * tag と checksum は上の 2 つの正規表現で形を閉じてから渡すこと。
 */
export function buildRecordSql(tag: string, checksum: string, appliedAt: number): string {
  assertTag(tag);
  assertChecksum(tag, checksum);
  if (!Number.isSafeInteger(appliedAt)) throw new Error(`MIGRATION_APPLIED_AT_INVALID:${tag}`);
  return (
    "INSERT INTO schema_version (tag, checksum, applied_at) VALUES " +
    `('${tag}', '${checksum}', ${String(appliedAt)})`
  );
}

/**
 * 全シャードへ順次適用する。
 *
 * 1 つのシャードで失敗したら、以降のシャードには一切触れずに投げる。
 * 例外にはシャード番号が載る。**CLI の出力には出すが（仕様 §19.8 が要求）、
 * HTTP レスポンスや外部ログへ転記しないこと**（architecture.md §1）。
 */
export async function runMigrations(
  deps: MigrateDeps,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const { shards, migrations, now, checkOnly = false } = options;

  for (const migration of migrations) assertTag(migration.tag);

  const withChecksum = await Promise.all(
    migrations.map(async (migration) => ({
      ...migration,
      checksum: await computeChecksum(migration.sql),
    })),
  );

  const ordered = [...shards].sort((a, b) => a.index - b.index);
  const statuses: ShardStatus[] = [];

  for (const shard of ordered) {
    try {
      statuses.push(await migrateShard(deps, shard, withChecksum, now, checkOnly));
    } catch (cause) {
      deps.log.error(
        `migration aborted at shard ${String(shard.index)} (${shard.databaseName}). ` +
          `remaining shards were not touched.`,
      );
      throw new Error(`MIGRATION_FAILED:SHARD_${String(shard.index).padStart(2, "0")}`, {
        cause,
      });
    }
  }

  const consistent = new Set(statuses.map((s) => s.currentTag ?? "")).size <= 1;
  if (!consistent) {
    deps.log.error(
      "schema_version mismatch across shards: " +
        statuses.map((s) => `${String(s.index)}=${s.currentTag ?? "none"}`).join(" "),
    );
  }

  return { shards: statuses, consistent };
}

async function migrateShard(
  deps: MigrateDeps,
  shard: ShardTarget,
  migrations: ReadonlyArray<MigrationSource & { checksum: string }>,
  now: Date,
  checkOnly: boolean,
): Promise<ShardStatus> {
  // 記録表が無いシャードでも読み出せるようにする。CREATE TABLE IF NOT EXISTS は
  // 何度実行しても同じ結果になるので、checkOnly でも実行してよい。
  await deps.execute(shard, SCHEMA_VERSION_DDL);

  const applied = await deps.query(shard, "SELECT tag, checksum FROM schema_version ORDER BY tag");
  const pending = planPending(migrations, applied);

  if (checkOnly || pending.length === 0) {
    if (pending.length > 0) {
      deps.log.info(`shard ${String(shard.index)}: ${String(pending.length)} pending`);
    } else {
      deps.log.info(`shard ${String(shard.index)}: up to date`);
    }
    return {
      index: shard.index,
      currentTag: latestTag(migrations, applied),
      pending,
      applied: [],
    };
  }

  const appliedNow: string[] = [];
  for (const tag of pending) {
    const migration = migrations.find((m) => m.tag === tag);
    if (!migration) throw new Error(`MIGRATION_MISSING_LOCALLY:${tag}`);

    await deps.execute(shard, migration.sql);
    await deps.execute(shard, buildRecordSql(tag, migration.checksum, now.getTime()));
    appliedNow.push(tag);
    deps.log.info(`shard ${String(shard.index)}: applied ${tag}`);
  }

  return {
    index: shard.index,
    currentTag: appliedNow[appliedNow.length - 1] ?? latestTag(migrations, applied),
    pending: [],
    applied: appliedNow,
  };
}

/** journal 順で最後に適用済みの tag。 */
function latestTag(
  migrations: ReadonlyArray<MigrationSource>,
  applied: readonly AppliedMigration[],
): string | null {
  const appliedTags = new Set(applied.map((row) => row.tag));
  let latest: string | null = null;
  for (const migration of migrations) {
    if (appliedTags.has(migration.tag)) latest = migration.tag;
  }
  return latest;
}
