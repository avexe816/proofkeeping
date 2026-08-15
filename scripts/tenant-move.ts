/**
 * `pnpm shards:move` の実体。テナント移送（PK-SPEC-P7 §4.4 / P7-07）。
 *
 * task: docs/tasks/P7-07.md
 * ルール: .claude/rules/architecture.md §1
 *
 * ── 使い方 ──────────────────────────────────────────────
 *   pnpm shards:move --env production --org <organizationId> --to 09 --plan
 *     何をするかだけ出す。**触らない。**
 *
 *   pnpm shards:move --env production --org <organizationId> --to 09 --copy
 *     手順 2（コピー）まで。**明示マッピングは書かない。**
 *
 *   pnpm shards:move --env production --org <organizationId> --to 09 --verify
 *     手順 3（照合）だけ。行数とチェックサムを突き合わせる。
 *
 * ── 既定は「何もしない」────────────────────────────────
 * 引数を付けずに叩くと `--plan` として動く。移送は**取りこぼしが
 * 即データ消失になる**操作なので、うっかり実行できない側に倒す。
 *
 * ── 手順 4・5・6 はここに無い ───────────────────────────
 * `--copy` と `--verify` までを実装してある。**明示マッピングの書き込み
 * （手順 4）と旧シャードの取り外し（手順 6）は自動化していない**
 * （docs/DECISIONS.md #162）。読み取り専用への切り替え（手順 1）が
 * 自動化できないので、**照合が通った時点のデータが最新である保証が無い。**
 * その保証を人が作ってから、人が書く。CLI は書くべき値を出力する。
 *
 * ── 判定そのものはここに書かない ────────────────────────
 * 表の選び方・チェックサム・照合は `packages/db/src/tenantMove.ts`
 * （純粋関数・テスト済み）。ここは wrangler を叩いて数字を集めるだけ。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "smol-toml";

// 拡張子が `.ts` なのは node が直接起動する入口だから（`db-migrate.ts` と同じ）。
import {
  TENANT_MOVE_STEPS,
  TENANT_MOVE_STEP_LABELS,
  assertShardMapValue,
  checksumOfRows,
  movableTablesOf,
  shardMapKey,
  verifyTenantMove,
  type TableSnapshot,
} from "../packages/db/src/tenantMove.ts";

const ROOT = join(import.meta.dirname, "..");
const WRANGLER_TOML = join(ROOT, "apps", "web", "wrangler.toml");

const ENVIRONMENTS = ["local", "preview", "staging", "production"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

type Mode = "plan" | "copy" | "verify";

interface D1Entry {
  binding: string;
  database_name: string;
}

interface ShardTarget {
  index: number;
  databaseName: string;
}

interface Options {
  env: Environment;
  organizationId: string;
  to: number;
  mode: Mode;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function parseArgs(argv: string[]): Options {
  const rawEnv = argValue(argv, "--env") ?? "local";
  if (!ENVIRONMENTS.includes(rawEnv as Environment)) {
    throw new Error(`unknown --env: ${rawEnv}. expected one of ${ENVIRONMENTS.join(" / ")}`);
  }

  const organizationId = argValue(argv, "--org");
  if (organizationId === undefined || organizationId.length === 0) {
    throw new Error("--org <organizationId> is required");
  }

  const rawTo = argValue(argv, "--to");
  if (rawTo === undefined) throw new Error("--to <shardIndex> is required");
  const to = Number(rawTo);

  // **既定は plan。** 引数を付け忘れた実行が触らない側へ落ちる。
  const mode: Mode = argv.includes("--copy")
    ? "copy"
    : argv.includes("--verify")
      ? "verify"
      : "plan";

  return { env: rawEnv as Environment, organizationId, to, mode };
}

/** wrangler.toml から対象環境の D1 一覧を読む（`shard-usage.ts` と同じ）。 */
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

/** FNV-1a 32bit（§19.3）。**`router.ts` と同じ実装であること。** */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 1 本へ SQL を投げて行を取る。**落ちたら例外**（移送は途中で止める）。 */
function query(
  environment: Environment,
  databaseName: string,
  sql: string,
): Record<string, unknown>[] {
  const args = ["d1", "execute", databaseName];
  if (environment === "local") args.push("--local");
  else args.push("--remote", "--env", environment);
  args.push("--json", "--command", sql);

  const stdout = execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: join(ROOT, "apps", "web"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // 1 表ぶんの行が丸ごと返る。既定の 1MB では足りない。
    maxBuffer: 256 * 1024 * 1024,
  });
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error("unexpected wrangler output");
  const parsed = JSON.parse(stdout.slice(start)) as Array<{ results?: Record<string, unknown>[] }>;
  return parsed.flatMap((entry) => entry.results ?? []);
}

/** SQL の文字列リテラルへ。**組織 ID は自己記述 ID だが、素で埋めない。** */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 移送対象の表を `sqlite_master` から取る（schema からではなく）。 */
function movableTables(environment: Environment, databaseName: string): string[] {
  const rows = query(
    environment,
    databaseName,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  return movableTablesOf(rows.map((row) => (typeof row["name"] === "string" ? row["name"] : "")));
}

/** 1 組織ぶんの行を読む。**`organization_id` で必ず絞る。** */
function tenantRows(
  environment: Environment,
  databaseName: string,
  table: string,
  organizationId: string,
): Record<string, unknown>[] {
  return query(
    environment,
    databaseName,
    `SELECT * FROM "${table}" WHERE organization_id = ${quote(organizationId)}`,
  );
}

async function snapshotOf(
  environment: Environment,
  databaseName: string,
  tables: readonly string[],
  organizationId: string,
): Promise<TableSnapshot[]> {
  const snapshots: TableSnapshot[] = [];
  for (const table of tables) {
    const rows = tenantRows(environment, databaseName, table, organizationId);
    snapshots.push({ table, rowCount: rows.length, checksum: await checksumOfRows(rows) });
  }
  return snapshots;
}

/** SQL の値リテラルへ。**JSON で組まない**（D1 は型を保つ）。 */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return quote(value);
  // D1 が返す値は null / number / string / boolean のいずれか。ここへは来ない。
  throw new Error(`UNEXPECTED_COLUMN_TYPE:${typeof value}`);
}

/** 1 表ぶんを移送先へ書く。**`INSERT OR REPLACE`**（やり直せるように）。 */
function copyTable(
  environment: Environment,
  targetDatabase: string,
  table: string,
  rows: readonly Record<string, unknown>[],
): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0] ?? {});
  const columnList = columns.map((column) => `"${column}"`).join(", ");

  // 1 文が長くなりすぎないように区切る。D1 の SQL 長には上限がある。
  const CHUNK = 200;
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const values = rows
      .slice(offset, offset + CHUNK)
      .map((row) => `(${columns.map((column) => literal(row[column])).join(", ")})`)
      .join(", ");
    query(
      environment,
      targetDatabase,
      `INSERT OR REPLACE INTO "${table}" (${columnList}) VALUES ${values}`,
    );
  }
}

function reportPlan(options: Options, from: ShardTarget, to: ShardTarget, tables: string[]): void {
  console.log(`org:   ${options.organizationId}`);
  console.log(`from:  shard ${String(from.index).padStart(2, "0")}（ハッシュで解決された現在地）`);
  console.log(`to:    shard ${String(to.index).padStart(2, "0")}`);
  console.log(`tables: ${String(tables.length)}`);
  console.log("");
  for (const [index, step] of TENANT_MOVE_STEPS.entries()) {
    const automated = step === "COPY" || step === "VERIFY";
    console.log(`  ${String(index + 1)}. ${TENANT_MOVE_STEP_LABELS[step]}${automated ? "" : "  ← 人が行う"}`);
  }
  console.log("");
  console.log("手順 4 で書く値:");
  console.log(`  SHARD_MAP  ${shardMapKey(options.organizationId)} = ${String(to.index)}`);
  console.log("  **TTL を付けないこと**（architecture.md §1）。");
}

function reportVerification(result: ReturnType<typeof verifyTenantMove>): void {
  console.log("");
  console.log(`verify: tables=${String(result.tables)} rows=${String(result.rows)}`);
  if (result.ok) {
    console.log("verify: OK（行数・チェックサムとも一致）");
    return;
  }
  console.log(`verify: MISMATCH（${String(result.mismatches.length)} 表）`);
  for (const mismatch of result.mismatches) {
    console.log(
      `  ${mismatch.table}  ${mismatch.reason}  ` +
        `source=${mismatch.sourceRowCount === null ? "—" : String(mismatch.sourceRowCount)} ` +
        `target=${mismatch.targetRowCount === null ? "—" : String(mismatch.targetRowCount)}`,
    );
  }
  console.log("");
  console.log("**手順 4 へ進まないこと。** 明示マッピングを書くと欠けた側が正になる。");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const targets = readShardTargets(options.env);

  assertShardMapValue(options.to, targets.length);

  const fromIndex = fnv1a32(options.organizationId) % targets.length;
  const from = targets.find((target) => target.index === fromIndex);
  const to = targets.find((target) => target.index === options.to);
  if (from === undefined) throw new Error(`source shard not declared: ${String(fromIndex)}`);
  if (to === undefined) throw new Error(`target shard not declared: ${String(options.to)}`);
  if (from.index === to.index) throw new Error("source and target are the same shard");

  const tables = movableTables(options.env, from.databaseName);
  reportPlan(options, from, to, tables);

  if (options.mode === "plan") {
    console.log("");
    console.log("（--plan。何も触っていない）");
    return;
  }

  if (options.mode === "copy") {
    console.log("");
    for (const table of tables) {
      const rows = tenantRows(options.env, from.databaseName, table, options.organizationId);
      copyTable(options.env, to.databaseName, table, rows);
      console.log(`  copied ${table}  rows=${String(rows.length)}`);
    }
  }

  const source = await snapshotOf(
    options.env,
    from.databaseName,
    tables,
    options.organizationId,
  );
  const target = await snapshotOf(options.env, to.databaseName, tables, options.organizationId);
  const result = verifyTenantMove(source, target);
  reportVerification(result);

  // **照合が通らなければ終了コードを立てる。** 続きの手順を止める材料。
  if (!result.ok) process.exitCode = 1;
}

await main();
