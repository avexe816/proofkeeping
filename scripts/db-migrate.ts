/**
 * `pnpm db:migrate` の実体。node 側のアダプタ。
 *
 * task: docs/tasks/P0-06.md
 * 仕様: docs/PK-SPEC-P0.md §19.8
 *
 * ── なぜランナー本体と分かれているのか ──────────────────
 * 適用計画のロジックは `packages/db/src/migrate.ts` にある（ファイル名は
 * docs/DECISIONS.md #009 が指定）。`packages/db` は Workers ランタイムの型で
 * 検査するため node 型を持てず、`node:fs` / `node:child_process` を置けない。
 * 本ファイルがその 2 つを引き受け、ランナーへ関数として注入する。
 *
 * ── 使い方 ──────────────────────────────────────────────
 *   pnpm db:migrate --env local              ローカル（miniflare）へ適用
 *   pnpm db:migrate --env local --check      未適用と不一致の検出だけ
 *   pnpm db:migrate --env production         production の 16 シャードへ
 *
 * local 以外は `--remote` で実在の D1 に触れる。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";

// 拡張子が `.ts` なのはこの 1 行だけ。node は TypeScript を直接実行できるが、
// TypeScript 側の慣習である `.js` → `.ts` の読み替えは行わない。
// 本ファイルは node が直接起動する唯一の入口なので、実際のファイル名で書く。
// （tsconfig.json の `allowImportingTsExtensions` が対になっている）
import {
  runMigrations,
  type AppliedMigration,
  type MigrationSource,
  type ShardTarget,
} from "../packages/db/src/migrate.ts";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER_TOML = join(ROOT, "apps", "web", "wrangler.toml");
const MIGRATIONS_DIR = join(ROOT, "packages", "db", "migrations");

const ENVIRONMENTS = ["local", "preview", "staging", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

interface D1Entry {
  binding: string;
  database_name: string;
}

interface JournalEntry {
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

function parseArgs(argv: string[]): { env: Environment; checkOnly: boolean } {
  const envIndex = argv.indexOf("--env");
  const raw = envIndex === -1 ? "local" : argv[envIndex + 1];
  if (raw === undefined || !ENVIRONMENTS.includes(raw as Environment)) {
    throw new Error(`unknown --env: ${String(raw)}. expected one of ${ENVIRONMENTS.join(" / ")}`);
  }
  return { env: raw as Environment, checkOnly: argv.includes("--check") };
}

/**
 * wrangler.toml から対象環境の D1 一覧を読む。
 *
 * wrangler の `[env.*]` は top-level を継承しないため、環境ごとに宣言が丸ごとある。
 * local は top-level の `d1_databases` を使う。
 */
function readShardTargets(environment: Environment): ShardTarget[] {
  const config = parse(readFileSync(WRANGLER_TOML, "utf8")) as Record<string, unknown>;

  const section =
    environment === "local"
      ? config
      : ((config["env"] as Record<string, Record<string, unknown>> | undefined)?.[environment] ??
        {});

  const entries = (section["d1_databases"] ?? []) as D1Entry[];
  if (entries.length === 0) {
    throw new Error(`no d1_databases declared for env ${environment}`);
  }

  return entries
    .map((entry) => {
      const matched = /^SHARD_(\d{2})$/.exec(entry.binding);
      if (!matched?.[1]) throw new Error(`unexpected d1 binding: ${entry.binding}`);
      return {
        index: Number(matched[1]),
        bindingName: entry.binding,
        databaseName: entry.database_name,
      };
    })
    .sort((a, b) => a.index - b.index);
}

/** journal の順序をそのまま適用順にする。ファイル名の辞書順に頼らない。 */
function readMigrations(): MigrationSource[] {
  const journalPath = join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;

  const files = new Set(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")));

  return journal.entries.map((entry) => {
    const fileName = `${entry.tag}.sql`;
    if (!files.has(fileName)) {
      throw new Error(`migration file missing: ${fileName}`);
    }
    return { tag: entry.tag, sql: readFileSync(join(MIGRATIONS_DIR, fileName), "utf8") };
  });
}

/** wrangler へ渡す共通の引数。local は miniflare のローカル DB を使う。 */
function wranglerArgs(environment: Environment, databaseName: string): string[] {
  const args = ["d1", "execute", databaseName];
  if (environment === "local") {
    args.push("--local");
  } else {
    args.push("--remote", "--env", environment);
  }
  return args;
}

/**
 * SQL を wrangler へ渡す形。**`--command=<sql>` と 1 語で渡す。**
 *
 * `["--command", sql]` の 2 語に分けてはならない。**SQL の先頭が `--` の
 * ときに壊れる。** wrangler の引数解析（yargs）は、値の位置にある語が
 * `--` で始まると「次のフラグ」と見なすため、`--command` は値を受け取れず、
 * SQL 本文がフラグ名として解釈される。
 *
 *   ✘ [ERROR] Unknown arguments:  P2-16 P1 暫定機能の移行（...
 *
 * 手書きのマイグレーションは先頭に `-- 見出し` を置く
 * （`0011_p2_16_inspection_policy_backfill.sql`）。**drizzle-kit の生成物は
 * `CREATE TABLE` から始まるので踏まない。** 手書きを足した時点で壊れており、
 * CI は `drizzle-kit check` しか行わない（実適用しない）ため検出されなかった。
 * `tests/toolchain/migrations.spec.ts` がこの形を押さえている。
 */
function commandArg(sql: string): string {
  return `--command=${sql}`;
}

/** 適用する SQL を置く一時ディレクトリ。プロセス 1 回につき 1 つ。 */
const SQL_DIR = mkdtempSync(join(tmpdir(), "pk-migrate-"));
let sqlFileSeq = 0;

/**
 * 適用する SQL は**ファイルで渡す**（`--file=<path>`）。
 *
 * ── なぜ `--command` ではないのか ───────────────────────
 * `--command` は 1 引数に SQL 全体を載せる。初回マイグレーション（0000）は
 * 表 15 個ぶんで数十 KB あり、**`--remote` はこれを受け取れない。**
 * local（miniflare）は通るので、**ローカルで確かめても分からない。**
 * 実際、staging の D1 で最初の 1 本目が落ちた。
 *
 * `--file` は wrangler が文へ分割して送る。**大きさに依らない。**
 * 先頭が `--` の SQL も、そもそも引数に載らないので問題にならない。
 *
 * 問い合わせ（`--json` の SELECT）は短いので `--command` のままでよい。
 */
function fileArg(sql: string): string {
  sqlFileSeq += 1;
  const path = join(SQL_DIR, `migration-${String(sqlFileSeq).padStart(4, "0")}.sql`);
  writeFileSync(path, sql, "utf8");
  return `--file=${path}`;
}

/**
 * wrangler を実行する。**stderr を捨てない。**
 *
 * 以前は `stdio` の 3 つ目が `"inherit"` で、失敗したときに例外へ載るのは
 * 「実行したコマンド（＝ SQL 全文）」だけだった。**wrangler が何と言って
 * 落ちたのかが、数十 KB の SQL に埋もれて読めない。** 捕まえて、最後の
 * 数行だけを出す。
 */
function runWrangler(environment: Environment, databaseName: string, extra: string[]): string {
  try {
    return execFileSync(
      "pnpm",
      ["exec", "wrangler", ...wranglerArgs(environment, databaseName), ...extra],
      { cwd: join(ROOT, "apps", "web"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const stdout = (error as { stdout?: string }).stdout ?? "";
    const tail = [stdout, stderr]
      .join("\n")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-20)
      .join("\n");
    console.error(`wrangler が失敗しました（${databaseName}）:\n${tail}`);
    throw new Error(`WRANGLER_FAILED:${databaseName}`);
  }
}

/**
 * `wrangler d1 execute --json` の結果から行を取り出す。
 *
 * wrangler は先頭に人間向けの行を混ぜることがあるため、最初の `[` から読む。
 */
function parseRows(stdout: string): AppliedMigration[] {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  const parsed = JSON.parse(stdout.slice(start)) as Array<{ results?: AppliedMigration[] }>;
  return parsed.flatMap((entry) => entry.results ?? []);
}

async function main(): Promise<void> {
  const { env: environment, checkOnly } = parseArgs(process.argv.slice(2));
  const shards = readShardTargets(environment);
  const migrations = readMigrations();

  console.log(
    `env=${environment} shards=${String(shards.length)} migrations=${String(migrations.length)}` +
      (checkOnly ? " (check only)" : ""),
  );

  const result = await runMigrations(
    {
      execute: (target, sql) => {
        runWrangler(environment, target.databaseName, [fileArg(sql)]);
        return Promise.resolve();
      },
      query: (target, sql) =>
        Promise.resolve(
          parseRows(runWrangler(environment, target.databaseName, ["--json", commandArg(sql)])),
        ),
      log: {
        info: (message) => {
          console.log(message);
        },
        error: (message) => {
          console.error(message);
        },
      },
    },
    { shards, migrations, now: new Date(), checkOnly },
  );

  const pending = result.shards.reduce((total, shard) => total + shard.pending.length, 0);

  if (!result.consistent) {
    console.error("schema_version does not match across shards.");
    process.exitCode = 1;
    return;
  }
  if (checkOnly && pending > 0) {
    console.error(`${String(pending)} migration(s) pending.`);
    process.exitCode = 1;
    return;
  }

  console.log(checkOnly ? "up to date." : "done.");
}

await main();
