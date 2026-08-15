/**
 * `pnpm shards:usage` の実体。シャード使用率の表示（PK-SPEC-P7 §4.3 / P7-06）。
 *
 * task: docs/tasks/P7-06.md
 * ルール: .claude/rules/architecture.md §1
 *
 * ── 使い方 ──────────────────────────────────────────────
 *   pnpm shards:usage --env local        ローカル（miniflare）
 *   pnpm shards:usage --env production   production の 16 シャード
 *   pnpm shards:usage --env production --json   機械可読で出す
 *
 * ── なぜ画面ではなく CLI なのか ─────────────────────────
 * §4.3 MUST は「シャード使用率を**管理者向けダッシュボード**で常時表示する」
 * と書く。一方 CLAUDE.md §4 は「**シャード番号を URL・レスポンス・ログに
 * 露出しない**」と定めており、テナントの画面へ出すことはできない。
 * この製品に「運用者（ステック社）」のロールは無く、7 ロールはすべて
 * 顧客側である（security.md §1）。
 *
 * **運用者向けの経路としては migration が先例になっている**
 * （architecture.md §6「1 つ失敗したら以降を中止し、シャード番号を出力」）。
 * `scripts/db-migrate.ts` と同じ場所・同じ形にした。運用者は wrangler の
 * 認証を持っており、追加の認証機構を発明せずに済む。
 *
 * **ダッシュボードとしてどこに出すかは未決**（docs/OPEN_QUESTIONS.md #095）。
 * 運用者向けの画面を作るなら、テナントのアプリとは別の Worker になる。
 *
 * ── 判定そのものはここに書かない ────────────────────────
 * 閾値（60 / 75 / 85%）とレベルの決め方は
 * `packages/db/src/shardUsage.ts`（純粋関数・テスト済み）。
 * ここは wrangler を叩いて数字を集め、並べるだけ。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "smol-toml";

// 拡張子が `.ts` なのは node が直接起動する入口だから（`db-migrate.ts` と同じ）。
import {
  SHARD_CAPACITY_BYTES,
  formatBytes,
  formatUsageRatio,
  needsAction,
  shardUsageLevelOf,
  worstLevelOf,
  type ShardUsageLevel,
} from "../packages/db/src/shardUsage.ts";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER_TOML = join(ROOT, "apps", "web", "wrangler.toml");

const ENVIRONMENTS = ["local", "preview", "staging", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

interface D1Entry {
  binding: string;
  database_name: string;
}

interface ShardTarget {
  index: number;
  databaseName: string;
}

interface ShardRow {
  index: number;
  sizeBytes: number | null;
  tenantCount: number | null;
  level: ShardUsageLevel;
  usageRatio: number | null;
}

function parseArgs(argv: string[]): { env: Environment; json: boolean } {
  const envIndex = argv.indexOf("--env");
  const raw = envIndex === -1 ? "local" : argv[envIndex + 1];
  if (raw === undefined || !ENVIRONMENTS.includes(raw as Environment)) {
    throw new Error(`unknown --env: ${String(raw)}. expected one of ${ENVIRONMENTS.join(" / ")}`);
  }
  return { env: raw as Environment, json: argv.includes("--json") };
}

/** wrangler.toml から対象環境の D1 一覧を読む（`db-migrate.ts` と同じ）。 */
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
      return { index: Number(matched[1]), databaseName: entry.database_name };
    })
    .sort((a, b) => a.index - b.index);
}

/** 1 本へ SQL を投げて行を取る。**落ちても例外にしない**（`null` を返す）。 */
function query(environment: Environment, databaseName: string, sql: string): unknown[] | null {
  const args = ["d1", "execute", databaseName];
  if (environment === "local") args.push("--local");
  else args.push("--remote", "--env", environment);
  args.push("--json", "--command", sql);

  try {
    const stdout = execFileSync("pnpm", ["exec", "wrangler", ...args], {
      cwd: join(ROOT, "apps", "web"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const start = stdout.indexOf("[");
    if (start === -1) return null;
    const parsed = JSON.parse(stdout.slice(start)) as Array<{ results?: unknown[] }>;
    return parsed.flatMap((entry) => entry.results ?? []);
  } catch {
    // **1 本が落ちていても他を報告する。** 落ちたことは `unknown` として出る。
    return null;
  }
}

/** 数値を 1 つ取り出す。**取れなければ `null`**（0 で埋めない）。 */
function readNumber(rows: unknown[] | null, column: string): number | null {
  const first = rows?.[0];
  if (typeof first !== "object" || first === null) return null;
  const value = (first as Record<string, unknown>)[column];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function collect(environment: Environment, targets: ShardTarget[]): ShardRow[] {
  return targets.map((target) => {
    const sizeRows = query(
      environment,
      target.databaseName,
      "SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS bytes",
    );
    const tenantRows = query(
      environment,
      target.databaseName,
      "SELECT count(*) AS count FROM organization",
    );

    const raw = readNumber(sizeRows, "bytes");
    // **0 は「測れていない」扱い**（`shardUsage.ts` と同じ判断）。
    const sizeBytes = raw !== null && raw > 0 ? raw : null;
    const usageRatio = sizeBytes === null ? null : sizeBytes / SHARD_CAPACITY_BYTES;

    return {
      index: target.index,
      sizeBytes,
      tenantCount: readNumber(tenantRows, "count"),
      usageRatio,
      level: shardUsageLevelOf(usageRatio),
    };
  });
}

/** §4.3 の閾値に対応する印。**色に頼らない**（ログに落ちても読める）。 */
const LEVEL_MARK: Readonly<Record<ShardUsageLevel, string>> = {
  unknown: "?",
  ok: " ",
  info: "i",
  warning: "!",
  critical: "!!",
};

function report(rows: ShardRow[]): void {
  console.log("shard  usage      size        tenants  level");
  for (const row of rows) {
    const index = String(row.index).padStart(2, "0");
    console.log(
      [
        `  ${index}`,
        formatUsageRatio(row.usageRatio).padStart(7),
        formatBytes(row.sizeBytes).padStart(10),
        (row.tenantCount === null ? "—" : String(row.tenantCount)).padStart(8),
        `${LEVEL_MARK[row.level]} ${row.level}`,
      ].join("  "),
    );
  }

  const worst = worstLevelOf(rows.map((row) => row.level));
  console.log("");
  console.log(`worst: ${worst}`);

  // §4.3 の「アーカイブの実行を検討」「テナント移送またはアーカイブを実行」。
  const acting = rows.filter((row) => needsAction(row.level));
  if (acting.length > 0) {
    console.log(
      `action needed on ${String(acting.length)} shard(s): ` +
        acting.map((row) => String(row.index).padStart(2, "0")).join(", "),
    );
    console.log("  75% → アーカイブの実行を検討 / 85% → テナント移送またはアーカイブを実行");
  }

  const unknown = rows.filter((row) => row.level === "unknown");
  if (unknown.length > 0) {
    // **測れていないことを緑として流さない。**
    console.log(
      `usage unavailable on ${String(unknown.length)} shard(s): ` +
        unknown.map((row) => String(row.index).padStart(2, "0")).join(", "),
    );
  }
}

function main(): void {
  const { env: environment, json } = parseArgs(process.argv.slice(2));
  const targets = readShardTargets(environment);
  const rows = collect(environment, targets);

  if (json) {
    console.log(JSON.stringify({ env: environment, shards: rows, worst: worstLevelOf(rows.map((row) => row.level)) }, null, 2));
    return;
  }
  report(rows);

  // **`critical` があれば終了コードを立てる。** 監視から叩けるようにする。
  if (rows.some((row) => row.level === "critical")) process.exitCode = 1;
}

main();
