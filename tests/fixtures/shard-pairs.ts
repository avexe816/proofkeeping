/**
 * テナント越境テスト用の組織 ID。
 *
 * task:  docs/tasks/P0-13.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── なぜ「同一シャードに落ちるペア」が要るのか ──────────
 * ProofKeeping には RLS が無い。テナント分離は 3 層の実装で守っており、
 * その第 1 層（`withTenantScope()` の組織条件）が本当に効いているかは、
 * **2 組織が同じ D1 に同居している状態でしか確かめられない。**
 * 別々のシャードに落ちる組織で「別組織のデータが見えない」を確かめても、
 * 物理的に到達不能なだけで、条件を消しても緑のままになる。
 * testing.md §2 が「第 3 のテストは必ず同一シャードに落ちる組織ペアで行う」
 * と定めているのはこのため。
 *
 * ── この定数の作り方 ────────────────────────────────────
 * `fnv1a32(organizationId) % 16` を総当たりして選んだ。
 * **値がそうなっていることは `_template.spec.ts` が実際に
 * `shardIndexOf()` を呼んで検査する。** ここに書いた注釈と実装が
 * 食い違ったら（ハッシュ関数を触った・SHARD_COUNT を変えた）テストが落ちる。
 * 手で書き換えず、落ちた理由のほうを疑うこと。
 *
 * ── import を持たないこと ───────────────────────────────
 * このファイルは `@pk/db` を import しない。**意図的**。
 * ルートの tsconfig は `tests/**` を node 型で検査しており、
 * `@pk/db` を引くと Workers ランタイム型（`D1Database` など）が解決できない。
 * 検証は Workers 型で検査される `tests/tenant-isolation/` 側で行う。
 */

/** 本番の SHARD_COUNT。ペアの前提（architecture.md §1「16 で固定」）。 */
export const PRODUCTION_SHARD_COUNT = 16;

/** ペアが落ちるシャード番号。 */
export const SAME_SHARD_INDEX = 7;

/**
 * **同一シャード（07）に同居する 2 組織。**
 *
 * 越境テストの第 3 パターンで使う。片方で書いたデータがもう片方から
 * 見えないことを、同じ D1 の中で確かめる。
 */
export const SAME_SHARD_ORG_PAIR = {
  a: {
    organizationId: "org_isolation_a18",
    orgShortId: "aa1111",
  },
  b: {
    organizationId: "org_isolation_b48",
    orgShortId: "bb2222",
  },
} as const;

/**
 * 別シャードに落ちる組織。**対照群。**
 *
 * 「同一シャードのペア」が本当に同一シャードであることを言うには、
 * そうでない例が要る（`SAME_SHARD_INDEX` 以外に落ちる）。
 */
export const OTHER_SHARD_ORG = {
  organizationId: "org_isolation_x0",
  orgShortId: "xx3333",
} as const;
