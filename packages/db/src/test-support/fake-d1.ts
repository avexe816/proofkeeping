/**
 * SQL を記録する D1 の代役。**テスト専用。** `src/index.ts` から公開しない。
 *
 * task: docs/tasks/P0-07.md
 *
 * ── なぜ実 D1 を使わないのか ────────────────────────────
 * P0-02 が未完で、実在する D1 は `proofkeeping-shard-00` の 1 本だけ。
 * リポジトリ層で検証したいのは「発行される SQL に `organization_id = ?` と
 * 施設スコープの条件が必ず載ること」であり、これは SQL を捕まえれば足りる。
 * `migrate.spec.ts` が採った「注入した代役で全分岐を決定的に検証する」方式に揃える。
 *
 * ── なぜ packages/db/src の下に置くのか ─────────────────
 * ルート tsconfig は `packages/db/**` を除外し、`tests/**` は node 型で検査する。
 * `D1Database` などの Workers ランタイム型は packages/db の tsconfig でしか
 * 解決できないため、この代役を `tests/fixtures/` へ置くと型が付かない。
 *
 * ── drizzle が呼ぶ経路 ──────────────────────────────────
 * `client.prepare(sql)` → `.bind(...params)` → `.raw()` / `.all()` / `.run()`
 * （drizzle-orm 0.45 の `d1/session.js`）。`select()` は `fields` を持つため
 * `raw()`（配列の配列）を通る。記録は `bind()` の時点で行う。
 */

import type { Env } from "../env.js";
import type { ShardContext, TenantContext } from "../router.js";
import type { Role } from "../schema/user.js";

/** 記録した 1 クエリ。 */
export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** SQL を記録する D1 代役。 */
export interface FakeD1 {
  /** 実行された順に積まれる。 */
  readonly queries: RecordedQuery[];
  /** `Env` に差し込む D1。 */
  readonly database: D1Database;
  /**
   * 次のクエリが返す行（`raw()` 形式＝配列の配列）を積む。
   * 積まなければ 0 件を返す。P0-07 の検証は SQL だけを見るため通常は使わない。
   */
  enqueueRows(rows: unknown[][]): void;
  /**
   * 次の書き込みが報告する影響行数を積む。**既定は 1。**
   *
   * `0` は `onConflictDoNothing()` で見送られた状態を表す
   * （`createRooms()` の `skipped` / `createRoomType()` の重複）。
   * 積まなければ「1 行書けた」として振る舞う。
   */
  enqueueChanges(changes: number): void;
}

export function createFakeD1(): FakeD1 {
  const queries: RecordedQuery[] = [];
  const pendingRows: unknown[][][] = [];
  const pendingChanges: number[] = [];

  const takeRows = (): unknown[][] => pendingRows.shift() ?? [];
  // **既定を 1 にする。** D1 の実装は成功した INSERT / UPDATE の行数を
  // 必ず返す。ここを空にしておくと `result.meta.changes` が `undefined` になり、
  // `changes > 0` を見る経路（`createRooms()` など）が代役の下でだけ
  // 常に「見送った」側へ倒れる。**代役が本物と違う分岐を通ると、
  // テストが通っていることの意味が変わる。**
  const takeChanges = (): number => pendingChanges.shift() ?? 1;

  const database = {
    prepare(sql: string) {
      const statement = {
        bind(...params: unknown[]) {
          queries.push({ sql, params });
          return statement;
        },
        raw: () => Promise.resolve(takeRows()),
        all: () =>
          Promise.resolve({ results: takeRows(), success: true, meta: { changes: takeChanges() } }),
        run: () => Promise.resolve({ success: true, meta: { changes: takeChanges() } }),
        first: () => Promise.resolve(takeRows()[0] ?? null),
      };
      return statement;
    },
  };

  // D1Database の全メソッド（batch / exec / dump / withSession）は drizzle の
  // select / insert 経路では呼ばれない。実装しないまま型だけ合わせる。
  return {
    queries,
    database: database as unknown as D1Database,
    enqueueRows(rows) {
      pendingRows.push(rows);
    },
    enqueueChanges(changes) {
      pendingChanges.push(changes);
    },
  };
}

/**
 * テスト用の `Env`。`SHARD_COUNT = 1` なので全組織が `SHARD_00` に落ちる。
 *
 * `SHARD_MAP` は常に null を返す（明示マッピング無し＝ハッシュで解決）。
 * R2 / Queue / secret は P0-07 のリポジトリが触らないため用意しない。
 */
export function createFakeEnv(fake: FakeD1): Env {
  return {
    SHARD_00: fake.database,
    SHARD_COUNT: "1",
    ENVIRONMENT: "local",
    SHARD_MAP: { get: () => Promise.resolve(null) },
  } as unknown as Env;
}

/** テスト用の組織識別子。仕様書の例（`o7k2m9`）を literal で使わない（DECISIONS #010）。 */
export const TEST_ORG = {
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
} as const;

/** 別組織。越境の検証に使う。 */
export const OTHER_ORG = {
  organizationId: "org_test_beta",
  orgShortId: "z9y8x7",
} as const;

/** 固定時刻。`ctx.now` の経路を決定的にする。 */
export const TEST_NOW = new Date("2026-08-11T00:00:00.000Z");

/** `ShardContext`（認証ブートストラップ用）。 */
export function shardContext(overrides: Partial<ShardContext> = {}): ShardContext {
  return { ...TEST_ORG, ...overrides };
}

/**
 * `TenantContext`。既定は組織全体ロール。
 *
 * 施設スコープの検証は `role` と `allowedPropertyIds` を明示して呼ぶこと。
 */
export function tenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  const base: TenantContext = {
    ...TEST_ORG,
    role: "ORG_ADMIN" satisfies Role,
    allowedPropertyIds: [],
    now: TEST_NOW,
  };
  return { ...base, ...overrides };
}
