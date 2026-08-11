/**
 * シャードルーター。組織 ID から D1 シャードを解決する唯一の場所。
 *
 * 仕様: docs/PK-SPEC-P0.md §19.2, §19.3
 * ルール: .claude/rules/architecture.md §1
 * task:  docs/tasks/P0-03.md
 *
 * ── このファイルの位置づけ ──────────────────────────────
 * テナント分離の第 1 層の入口。アプリケーションコードが使ってよいのは
 * `getTenantDb()` のみで、`env.SHARD_XX` へ直接触ることは禁止する
 * （ESLint `no-direct-shard-access` で強制するのは P0-04）。
 *
 * 仕様 §19.3 は `no-raw-drizzle` の例外を
 * 「`packages/db/src/router.ts`、マイグレーションランナー、シード」と
 * 定めている。**P0-04 で `no-raw-drizzle` を実装するとき、
 * このファイルを allowlist に入れること。**
 *
 * ── 設計方針: 曖昧なら必ず落とす ────────────────────────
 * シャード解決の誤りは 404 やエラーにならない。誤ったシャードへ
 * 読み書きが向かい、同一テナントのデータが複数シャードに分裂する。
 * この破損は無警告で進行し、テナント越境テストにも引っかからない
 * （分離自体は破れていないため）。
 *
 * したがって本ファイルは、解決結果に少しでも疑いがある場合に
 * フォールバックも clamp もせず、必ず例外を投げる。可用性より
 * 破損回避を優先する（docs/DECISIONS.md #007）。
 *
 * ── SHARD_MAP を書くときの MUST ─────────────────────────
 * 本ファイルは `SHARD_MAP` を **読むだけ** で、書き込みは行わない
 * （組織の移送手順に属する。所有 task は未定 — OPEN_QUESTIONS #007）。
 * 将来書き込みを実装する者は以下を守ること。
 *
 *   - `expirationTtl` / `expiration` を指定しない。TTL 厳禁。
 *   - 明示マッピング（`shard:{organizationId}`）以外のキーを置かない。
 *   - 一括削除・一括上書きをしない。削除は 1 組織の移送完了時のみ。
 *   - 組織を別シャードへ移送したら、**移送の完了前に** 書く。
 *
 * ── エラーメッセージの取り扱い ──────────────────────────
 * `SHARD_BINDING_MISSING:SHARD_07` はシャード番号を含む。文言は
 * 仕様 §19.3 が定めたものなのでそのまま投げるが、architecture.md §1 の
 * 「シャード番号を URL・レスポンス・ログに露出しない」に従い、
 * **これらの例外を HTTP レスポンスや外部ログへそのまま出さないこと。**
 * 変換は呼び出し側（P0-20 のエラーハンドリング）の責務とする。
 */

import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import type { Env } from "./env.js";

/**
 * リポジトリ関数が必須引数に取るテナント文脈。
 *
 * ここでは解決に必要な最小限だけを持つ。`role` / `allowedPropertyIds` は
 * 施設スコープの絞り込み（architecture.md §2 第 1 層）で必要になるため
 * P0-07 / P0-10 が追加する。
 */
export interface TenantContext {
  /** 組織 ID。シャード解決のキー。 */
  organizationId: string;
  /** ID の自己記述検証に使う 6 桁英数（architecture.md §2 第 2 層）。 */
  orgShortId: string;
}

/** シャード数の上限。仕様 §19.2 の「16 で固定。実行時に増減しない」。 */
const MAX_SHARD_COUNT = 16;

/** `SHARD_MAP` のキー接頭辞。 */
const SHARD_MAP_KEY_PREFIX = "shard:";

/** 明示マッピングの値として許すのは 10 進の非負整数のみ。 */
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * FNV-1a 32bit ハッシュ。仕様 §19.3 の実装をそのまま持つ。
 *
 * **アルゴリズムを外部パッケージへ置き換えないこと。** 実装が変われば
 * 既存組織のバケット割当が変わり、移送手続きを踏まないまま読み書きが
 * 別シャードへ向かう。既知値は router.spec.ts で固定してある。
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * シャード数として妥当かを検証する。1 以上 `MAX_SHARD_COUNT` 以下の整数のみ。
 *
 * `SHARD_COUNT` が 0 だと `x % 0` が NaN になり、`SHARD_undefined` という
 * binding を引きに行って解決不能になる。NaN を作らせないためここで落とす。
 */
function assertShardCount(shardCount: number, raw: string): void {
  if (
    !Number.isInteger(shardCount) ||
    shardCount < 1 ||
    shardCount > MAX_SHARD_COUNT
  ) {
    throw new Error(`SHARD_COUNT_INVALID:${raw}`);
  }
}

/**
 * `env.SHARD_COUNT`（文字列）を検証済みの整数にする。
 *
 * `wrangler.toml` の全環境で `[vars]` に宣言されていること、および
 * D1 binding の本数と一致することは tests/toolchain/wrangler.spec.ts が保証する。
 */
function readShardCount(env: Env): number {
  const raw = env.SHARD_COUNT;
  // Number("") === 0 / Number(" 2 ") === 2 のような緩さを避け、書式から見る。
  const trimmed = raw.trim();
  const shardCount = NON_NEGATIVE_INTEGER.test(trimmed) ? Number(trimmed) : Number.NaN;
  assertShardCount(shardCount, raw);
  return shardCount;
}

/**
 * 組織 ID をハッシュしてシャード番号を得る純粋関数。KV も env も見ない。
 *
 * 明示マッピングは見ないため、**アプリケーションコードはこれを直接使わない。**
 * `resolveShard()` / `getTenantDb()` を使うこと。公開しているのは
 * 分散のテストとマイグレーションランナーのため。
 */
export function shardIndexOf(organizationId: string, shardCount: number): number {
  assertShardCount(shardCount, String(shardCount));
  return fnv1a32(organizationId) % shardCount;
}

/**
 * `SHARD_MAP` の明示マッピングを読む。未設定なら null。
 *
 * 値が読めたが妥当でない（数値でない・負数・`shardCount` 以上）場合は
 * **ハッシュへフォールバックせず例外にする。** 移送済み組織で静かに
 * ハッシュへ落ちると、以後の読み書きが移送前のシャードへ向かい、
 * テナントのデータが分裂する（docs/DECISIONS.md #006 / #007）。
 */
async function readExplicitMapping(
  env: Env,
  organizationId: string,
  shardCount: number,
): Promise<number | null> {
  const raw = await env.SHARD_MAP.get(`${SHARD_MAP_KEY_PREFIX}${organizationId}`);
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (!NON_NEGATIVE_INTEGER.test(trimmed)) {
    throw new Error(`SHARD_MAP_INVALID:${organizationId}`);
  }

  const idx = Number(trimmed);
  if (idx >= shardCount) {
    // 例: 本番の値（7）を SHARD_COUNT=1 のローカルへ持ち込んだ場合。
    // 値そのものはメッセージに含めない（シャード番号を露出しない）。
    throw new Error(`SHARD_MAP_INVALID:${organizationId}`);
  }
  return idx;
}

/**
 * 組織のシャード番号を解決する。明示マッピングがハッシュより優先される。
 *
 * 戻り値は必ず `0 <= idx < SHARD_COUNT` を満たす。満たせない場合は投げる。
 */
export async function resolveShard(env: Env, organizationId: string): Promise<number> {
  const shardCount = readShardCount(env);

  const explicit = await readExplicitMapping(env, organizationId, shardCount);
  const idx = explicit ?? shardIndexOf(organizationId, shardCount);

  // ここへ到達する経路はすべて検証済みで、構造上この条件は成立しない。
  // それでも置くのは、範囲外のまま binding を引くと `SHARD_undefined` の
  // 「binding 欠落」として現れ、原因が値の破損だと分からなくなるため。
  if (!Number.isInteger(idx) || idx < 0 || idx >= shardCount) {
    throw new Error(`SHARD_INDEX_OUT_OF_RANGE:${organizationId}`);
  }
  return idx;
}

/**
 * 組織に対応する D1 binding を返す。
 *
 * binding が宣言されていない（`wrangler.toml` の宣言漏れ・`SHARD_COUNT` と
 * 実際の binding 数の不一致）場合は、どの binding が無いのかが分かる
 * メッセージで落とす。仕様 §19.3 の `SHARD_BINDING_MISSING:{key}`。
 */
export async function getShardBinding(env: Env, organizationId: string): Promise<D1Database> {
  const idx = await resolveShard(env, organizationId);
  const key = `SHARD_${String(idx).padStart(2, "0")}` as keyof Env;
  const db = env[key] as D1Database | undefined;
  if (!db) throw new Error(`SHARD_BINDING_MISSING:${key}`);
  return db;
}

/**
 * アプリケーションコードが唯一使ってよい入口。
 *
 * `resolveShard()` が KV を読むため非同期。仕様 §19.3 のコード例は同期だが、
 * 同 §19.3 の `resolveShard` に明示マッピングが無く、architecture.md §1 と
 * P0-03 の完了条件が KV 優先を要求している（OPEN_QUESTIONS #008）。
 *
 * schema 引数は Drizzle スキーマを追加する P0-06 で渡す。
 */
export async function getTenantDb(env: Env, ctx: TenantContext): Promise<DrizzleD1Database> {
  return drizzle(await getShardBinding(env, ctx.organizationId));
}
