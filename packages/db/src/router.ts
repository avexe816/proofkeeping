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
import * as globalSchema from "./schema/global.js";
import * as tenantSchema from "./schema/index.js";
import type { Role } from "./schema/user.js";

/**
 * シャード解決と ID の自己記述検証に必要な最小限の文脈。
 *
 * **`TenantContext` と分けてある理由**（P0-07 / docs/DECISIONS.md #016）:
 * `TenantContext.allowedPropertyIds` は `membership` と `property_assignment` を
 * 引かなければ作れない。その 2 つを引く関数までが `TenantContext` を要求すると、
 * 認証（P0-08 / P0-10）が文脈を組み立てられなくなる（循環する）。
 * ロールが確定する前でも作れる文脈をここに切り出し、
 * **この型で足りるのは認証ブートストラップの 2 関数だけ**とする
 * （`repositories/user.ts` の `findMembershipByUserId` / `listAssignedPropertyIds`）。
 *
 * 業務リポジトリはすべて `TenantContext` を要求すること。
 */
export interface ShardContext {
  /** 組織 ID。シャード解決のキー。 */
  organizationId: string;
  /** ID の自己記述検証に使う 6 桁英数（architecture.md §2 第 2 層）。 */
  orgShortId: string;
}

/**
 * リポジトリ関数が必須引数に取るテナント文脈。
 *
 * 値を作るのはセッション middleware（P0-10）。**リクエストのボディ・クエリ・
 * パス変数から `organizationId` を採らないこと**（PK-SPEC-P0 §19.4 / §19.5）。
 */
export interface TenantContext extends ShardContext {
  /**
   * `membership.role`。施設スコープの絞り込みに使う（architecture.md §2 第 1 層）。
   *
   * 1 ユーザーが複数ロールを持つ設計にはなっていない（`membership` は
   * 組織 × ユーザーで unique）。
   */
  role: Role;
  /**
   * 施設スコープロールの担当施設。`property_assignment` から組み立てる
   * （列としては持たせていない / P0-06 申し送り 1）。
   *
   * **空配列は「全施設」ではなく「1 件も見えない」を意味する。**
   * 組織全体ロール（OWNER / ORG_ADMIN / AUDITOR）ではこの値を参照しない。
   */
  allowedPropertyIds: readonly string[];
  /**
   * 現在時刻。`createdAt` / `updatedAt` はこれを使う。
   *
   * リポジトリ層で `Date.now()` / `new Date()` を直接呼ばないこと
   * （CLAUDE.md §5。`schema/columns.ts` の `timestamps` が前提にしている）。
   */
  now: Date;
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
 * 渡すスキーマはテナントスコープの表だけ（`schema/index.ts`）。
 * 全局テーブルはここから引けない（P0-06）。
 *
 * 引数が `ShardContext` なのはシャード解決に組織 ID しか要らないため。
 * `TenantContext` は部分型なのでそのまま渡せる。
 * **返る db から直に `select()` しないこと。** クエリはリポジトリ関数を通し、
 * `withTenantScope()` で `organizationId` 条件を必ず載せる（PK-SPEC-P0 §19.4 第1層）。
 */
export async function getTenantDb(
  env: Env,
  ctx: ShardContext,
): Promise<DrizzleD1Database<typeof tenantSchema>> {
  return drizzle(await getShardBinding(env, ctx.organizationId), { schema: tenantSchema });
}

/** 全局テーブルを置くシャード。仕様 §19.2 の「開発・検証は SHARD_00 のみ」と揃う。 */
const GLOBAL_SHARD_INDEX = 0;

/**
 * 全局（テナント横断）テーブル専用の DB を返す。**SHARD_00 に固定。**
 *
 * 用途は `org_directory` による `orgShortId` の全局一意の担保のみ
 * （docs/DECISIONS.md #014）。組織 ID を取らないのは、この経路が
 * テナントに紐づかない唯一の入口だからで、**テナントデータの取得に使わないこと。**
 *
 * 誤用を型で塞いである。返る DB のスキーマは `schema/global.ts` だけなので、
 * ここから `task` や `room` を引くコードはコンパイルが通らない。
 * これが `getTenantDb()` の迂回路になると、シャード分離もテナント分離も
 * 一度に無効化される。
 *
 * `resolveShard()` を通さないのは、解決すべき組織が存在しないため。
 * `SHARD_COUNT` が 1 でも 16 でも同じ SHARD_00 を指す。
 */
export function getGlobalDb(env: Env): DrizzleD1Database<typeof globalSchema> {
  const key = `SHARD_${String(GLOBAL_SHARD_INDEX).padStart(2, "0")}` as keyof Env;
  const db = env[key] as D1Database | undefined;
  if (!db) throw new Error(`SHARD_BINDING_MISSING:${key}`);
  return drizzle(db, { schema: globalSchema });
}
