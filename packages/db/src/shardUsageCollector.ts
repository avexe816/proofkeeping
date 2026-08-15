/**
 * シャードの使用率を集める（PK-SPEC-P7 §4.3 / P7-06）。
 *
 * task: docs/tasks/P7-06.md
 *
 * ── なぜ `shardUsage.ts` と分かれているのか ─────────────
 * あちらは閾値とレベルの判定（純粋関数）で、**node が直接起動する
 * `scripts/shard-usage.ts` から import する。** こちらは `D1Database` を
 * 触るので Workers の型が要り、node 側の tsconfig では検査できない。
 * 同じ判定を CLI と Worker の両方から使うために、型の依存で割ってある。
 *
 * ── 運用者向けであってテナント向けではない ──────────────
 * **シャード番号を持つ値を返す。** テナント向けの API・画面から
 * 呼ばないこと（`shardUsage.ts` の注記 / CLAUDE.md §4）。
 */

import type { Env } from "./env.js";
import { listShardDatabases } from "./router.js";
import {
  SHARD_CAPACITY_BYTES,
  shardUsageLevelOf,
  worstLevelOf,
  type ShardUsageLevel,
} from "./shardUsage.js";

/** シャード 1 本ぶんの状態。 */
export interface ShardUsage {
  /** シャード番号（0 起点）。**テナントへ出さない**（冒頭の注記）。 */
  index: number;
  /** 問い合わせが通ったか。 */
  reachable: boolean;
  /** バイト数。**取れなければ `null`**（0 で埋めない）。 */
  sizeBytes: number | null;
  /** 0〜1。`sizeBytes` が `null` なら `null`。 */
  usageRatio: number | null;
  level: ShardUsageLevel;
  /** そのシャードに載っている組織の数。**引けなければ `null`。** */
  tenantCount: number | null;
  /** 使用率を測った問い合わせにかかった時間（ミリ秒）。 */
  probeDurationMs: number | null;
}

/** 全体の報告。 */
export interface ShardUsageReport {
  /** `SHARD_COUNT` が期待する本数。 */
  expected: number;
  /** `wrangler.toml` に binding が在る本数。 */
  declared: number;
  shards: ShardUsage[];
  /** いちばん重いレベル。**運用者はまずこれを見る。** */
  worst: ShardUsageLevel;
}

/**
 * 1 本のサイズをバイトで測る。**例外を投げない。**
 *
 * SQLite の `page_count × page_size`。D1 がこの 2 つの pragma を通すかは
 * 環境による（通らなければ `null`）。**`dbstat` は使わない**：
 * 仮想テーブルが有効でない環境が多く、全ページを走査するので重い。
 */
async function readSizeBytes(db: D1Database): Promise<number | null> {
  try {
    const result = await db
      .prepare("SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS bytes")
      .first<{ bytes: number | null }>();
    const bytes = result?.bytes ?? null;
    // **0 を返してきたら「取れていない」扱い。** 空の D1 でも
    // schema があれば数ページは使う。0 は測れていない徴候。
    return typeof bytes === "number" && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * 1 本に載っている組織の数を数える。**例外を投げない。**
 *
 * **`org_directory`（SHARD_00 の全局表）ではなく各シャードの
 * `organization` を数える。** 全局表を数えて `resolveShard()` で
 * 割り振り直すと、明示マッピング（`SHARD_MAP`）で移送済みの組織が
 * 移送前のシャードに数えられる。**実際に行が在る場所を数える。**
 */
async function readTenantCount(db: D1Database): Promise<number | null> {
  try {
    const result = await db
      .prepare("SELECT count(*) AS count FROM organization")
      .first<{ count: number | null }>();
    return result?.count ?? null;
  } catch {
    return null;
  }
}

/**
 * 16 シャードの使用率を集める（§4.3 MUST）。
 *
 * **`getTenantDb()` を通らない。** これはテナントの文脈を持たない
 * 運用者の照会で、全シャードを順に見るのが目的そのもの
 * （architecture.md §3 が禁じる「全シャード走査」は**テナントのデータを
 * 探すための**走査を指す）。
 *
 * **例外を投げない。** 1 本が落ちていても他の 15 本は報告する。
 */
export async function collectShardUsage(env: Env): Promise<ShardUsageReport> {
  const { expected, declared } = listShardDatabases(env);

  const shards = await Promise.all(
    declared.map(async (db, index): Promise<ShardUsage> => {
      const startedAt = Date.now();
      const [sizeBytes, tenantCount] = await Promise.all([
        readSizeBytes(db),
        readTenantCount(db),
      ]);
      const probeDurationMs = Date.now() - startedAt;
      const usageRatio = sizeBytes === null ? null : sizeBytes / SHARD_CAPACITY_BYTES;
      return {
        index,
        // サイズもテナント数も引けなければ到達できていない。
        reachable: sizeBytes !== null || tenantCount !== null,
        sizeBytes,
        usageRatio,
        level: shardUsageLevelOf(usageRatio),
        tenantCount,
        probeDurationMs,
      };
    }),
  );

  return {
    expected,
    declared: declared.length,
    shards,
    worst: worstLevelOf(shards.map((shard) => shard.level)),
  };
}

