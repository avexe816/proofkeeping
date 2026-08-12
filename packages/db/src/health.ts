/**
 * ヘルスチェック。**シャード・R2・KV の到達性と `schema_version` の一致を見る。**
 *
 * task:  docs/tasks/P0-20.md
 * 仕様:  docs/PK-SPEC-P0.md §13.8, §19.8
 * ルール: .claude/rules/architecture.md §1（シャード番号を外へ出さない）, §6
 *
 * ── 番号を返さない ──────────────────────────────────────
 * §13.8 は「16 シャードの状態を返す」と読めるが、architecture.md §1 は
 * シャード番号をレスポンスとログに出すことを禁じている。
 * `/api/health` は**認証を要求しない経路**なので、内部構成を語らせない。
 * ここが返すのは **件数と真偽だけ**で、どの番号のシャードが落ちているかは
 * 含めない。番号が要る運用（マイグレーションの中止位置）は
 * `migrate.ts` が担い、そちらは CI とオペレータの手元にしか出力しない。
 *
 * ── Queue を能動的に叩かない ────────────────────────────
 * Queue には「読めるか」を試す API が無い。確かめるにはメッセージを
 * 送るしかなく、ヘルスチェックのたびに消費者へ空メッセージが流れる。
 * **binding が宣言されているかまで**にとどめる。
 *
 * ── 書き込み系 API の 503 はここに無い ──────────────────
 * §19.8 は `schema_version` 不一致で書き込み系 API を 503 にすると定める。
 * その判定は毎リクエストで 16 シャードを引けないため、結果をキャッシュする
 * 設計が要る。**P0-20 の範囲は /api/health の 1 経路のみ**とし、
 * 503 の middleware は未実装。docs/PROGRESS.md の申し送りを参照。
 */

import type { Env } from "./env.js";
import { listShardDatabases } from "./router.js";

/** 各部位の状態。**理由の内訳を外へ出さない。** */
export type HealthState = "ok" | "degraded";

/** シャードの状態。**番号を持たない。件数だけ。** */
export interface ShardHealth {
  state: HealthState;
  /** `SHARD_COUNT` が期待する本数。 */
  expected: number;
  /** `wrangler.toml` に binding が在る本数。 */
  declared: number;
  /** 実際に問い合わせが通った本数。 */
  reachable: number;
  /**
   * 全シャードの `schema_version` が一致しているか（§19.8）。
   * 到達できないシャードがある場合は判定できないので `false`。
   */
  schemaVersionConsistent: boolean;
}

/** ヘルスチェックの結果。 */
export interface HealthReport {
  state: HealthState;
  shards: ShardHealth;
  /** R2。1 バケットへの `head` が通れば ok。 */
  storage: HealthState;
  /** Workers KV。セッション namespace への `get` が通れば ok。 */
  cache: HealthState;
  /** Queue。**送信せず binding の宣言だけを見る**（冒頭の注記）。 */
  queues: HealthState;
}

/** 到達性を確かめるだけのキー。**存在しなくてよい。** */
const PROBE_KEY = "health:probe";

/**
 * 1 シャードの `schema_version` を読み、適用済みタグを昇順で返す。
 *
 * 例外は投げない。読めなければ `null`（＝到達できない）。
 * **ここで落とすと 1 本の不調で全体の報告ができなくなる。**
 */
async function readSchemaTags(db: D1Database): Promise<string[] | null> {
  try {
    const result = await db.prepare("SELECT tag FROM schema_version ORDER BY tag").all<{
      tag: string;
    }>();
    return result.results.map((row) => row.tag);
  } catch {
    return null;
  }
}

/** 全シャードの状態を集める。 */
async function checkShards(env: Env): Promise<ShardHealth> {
  const { expected, declared } = listShardDatabases(env);
  const tagLists = await Promise.all(declared.map((db) => readSchemaTags(db)));

  const reached = tagLists.filter((tags): tags is string[] => tags !== null);
  const reachable = reached.length;

  // 全シャードが同じ適用済み集合を持つこと（§19.8）。
  // 1 本でも到達できなければ「一致している」とは言えない。
  const complete = reachable === expected && declared.length === expected;
  const first = reached[0];
  const schemaVersionConsistent =
    complete && first !== undefined && reached.every((tags) => tags.join(",") === first.join(","));

  return {
    state: complete && schemaVersionConsistent ? "ok" : "degraded",
    expected,
    declared: declared.length,
    reachable,
    schemaVersionConsistent,
  };
}

/** R2。**バケットを 1 本だけ叩く。** 4 本すべてを毎回叩く必要は無い。 */
async function checkStorage(env: Env): Promise<HealthState> {
  try {
    await env.DOCUMENTS.head(PROBE_KEY);
    return "ok";
  } catch {
    return "degraded";
  }
}

/** KV。セッションが引けないとログイン済みの利用者が全員止まる。 */
async function checkCache(env: Env): Promise<HealthState> {
  try {
    await env.SESSION.get(PROBE_KEY);
    return "ok";
  } catch {
    return "degraded";
  }
}

/** Queue の binding が 7 本とも在るか（architecture.md §5）。送信はしない。 */
function checkQueues(env: Env): HealthState {
  // 型の上では必須だが、wrangler.toml の宣言漏れは実行時に undefined で届く。
  // **そこを見るのがこの関数の仕事**なので、緩い型で受け直す。
  const bindings: readonly (Queue | undefined)[] = [
    env.QUEUE_PDF_GENERATION,
    env.QUEUE_EVIDENCE_EXPORT,
    env.QUEUE_RECONCILIATION,
    env.QUEUE_ROLLUP_UPDATE,
    env.QUEUE_BASELINE_LEARNING,
    env.QUEUE_NOTIFICATION,
    env.QUEUE_ARCHIVE_RESTORE,
  ];
  return bindings.every((queue) => queue !== undefined) ? "ok" : "degraded";
}

/**
 * ヘルスチェックを実行する。**例外を投げない。**
 *
 * どこかが落ちていることを 500 ではなく報告として返す。呼び出し側
 * （`routes/api/health.ts`）が全体の state を HTTP ステータスへ写す。
 */
export async function checkHealth(env: Env): Promise<HealthReport> {
  const [shards, storage, cache] = await Promise.all([
    checkShards(env),
    checkStorage(env),
    checkCache(env),
  ]);
  const queues = checkQueues(env);

  const state: HealthState =
    shards.state === "ok" && storage === "ok" && cache === "ok" && queues === "ok"
      ? "ok"
      : "degraded";

  return { state, shards, storage, cache, queues };
}
