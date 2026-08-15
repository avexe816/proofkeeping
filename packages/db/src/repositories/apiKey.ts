/**
 * 公開 API のキー（`apiKey`）のリポジトリ（PK-SPEC-P6 §6.1 / P6-12）。
 *
 * task: docs/tasks/P6-12.md
 * ルール: .claude/rules/security.md §7
 *
 * ── 平文を受け取らない・返さない（§6.1 MUST）─────────────
 * この層が扱うのは `keyHash`（SHA-256）と `keyPrefix`（表示用の先頭）だけ。
 * **平文のトークンを引数に取る関数も、返す関数も無い。** 発行は
 * `apps/web/src/lib/auth/apiKey.ts` の `issueApiKey()` が行い、
 * 呼び出し元が 1 回だけ応答に載せる。
 *
 * ── 行を消さない ────────────────────────────────────────
 * 失効は `revokedAt` を立てるだけ。**誰がいつ作って、いつ失効させたかを
 * 残す。** 消すと「そのキーで入ってきたリクエストは何だったのか」を
 * 事後に辿れなくなる。
 */

import { desc, eq, isNull } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { apiKey, type ApiScope } from "../schema/integration.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/** `createApiKey()` の入力。**平文のトークンを受け取らない。** */
export interface CreateApiKeyInput {
  name: string;
  /** 表示用の先頭（`pk_live_o7k2m9`）。 */
  keyPrefix: string;
  /** トークン全体の SHA-256（16 進）。 */
  keyHash: string;
  scopes: readonly ApiScope[];
  /** `null` = 組織全体。配列 = その施設だけ。`[]` = 1 件も見えない。 */
  propertyIds: readonly string[] | null;
  expiresAt?: Date | null | undefined;
  /** 作成した `membership.id`。 */
  createdById: string;
}

/**
 * キーを作る（§6.1）。
 *
 * **`propertyIds` の各要素も越境検査に掛ける。** 他組織の施設 ID を
 * 混ぜたキーを作れると、そのキーで他組織の施設を名乗れることになる。
 */
export async function createApiKey(env: Env, ctx: TenantContext, input: CreateApiKeyInput) {
  if (input.propertyIds !== null) {
    for (const propertyId of input.propertyIds) assertIdBelongsToTenant(propertyId, ctx);
  }
  const db = await getTenantDb(env, ctx);
  const row = {
    id: generateId(ctx.orgShortId, "akey"),
    organizationId: ctx.organizationId,
    name: input.name,
    keyPrefix: input.keyPrefix,
    keyHash: input.keyHash,
    scopes: [...input.scopes],
    propertyIds: input.propertyIds === null ? null : [...input.propertyIds],
    lastUsedAt: null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdById: input.createdById,
    createdAt: ctx.now,
  };
  await db.insert(apiKey).values(row);
  return row;
}

/**
 * キーの一覧（管理画面）。**`keyHash` を返さない。**
 *
 * ハッシュ自体は認証情報ではないが、画面へ出す理由が無い。
 * 出すと「それらしい値」がスクリーンショットや問い合わせに載る。
 */
export async function listApiKeys(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      propertyIds: apiKey.propertyIds,
      lastUsedAt: apiKey.lastUsedAt,
      expiresAt: apiKey.expiresAt,
      revokedAt: apiKey.revokedAt,
      createdById: apiKey.createdById,
      createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(withTenantScope(apiKey, ctx, NO_PROPERTY_SCOPE))
    .orderBy(desc(apiKey.createdAt), apiKey.id);
}

/**
 * ハッシュでキーを引く（公開 API の認証）。
 *
 * **`ctx` はトークンから組み立てたもの**（`lib/auth/apiKey.ts` の注記）。
 * 組織短縮 ID がトークンに埋まっているのでシャードが決まり、
 * 全シャード走査（architecture.md §3 で禁止）にならない。
 *
 * **失効・期限の判定はここでしない。** `isApiKeyUsable()` の責務で、
 * 行を返してから見る。ここで落とすと「キーが無い」と「失効した」を
 * 呼び出し側が区別できず、監査ログに理由を残せない。
 */
export async function findApiKeyByHash(env: Env, ctx: TenantContext, keyHash: string) {
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select()
    .from(apiKey)
    .where(withTenantScope(apiKey, ctx, NO_PROPERTY_SCOPE, eq(apiKey.keyHash, keyHash)))
    .limit(1);
  return row;
}

/**
 * 失効させる（§6.1）。**行は消さない。**
 *
 * 冪等ではない方向へ倒してある。**既に失効しているキーの `revokedAt` を
 * 動かさない**（`isNull` の条件）。最初に失効させた時刻が事実。
 */
export async function revokeApiKey(env: Env, ctx: TenantContext, apiKeyId: string): Promise<void> {
  assertIdBelongsToTenant(apiKeyId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(apiKey)
    .set({ revokedAt: ctx.now })
    .where(
      withTenantScope(
        apiKey,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(apiKey.id, apiKeyId),
        isNull(apiKey.revokedAt),
      ),
    );
}

/**
 * 最終利用時刻を進める（§6.1 の `lastUsedAt`）。
 *
 * **1 リクエストにつき 1 回の書き込みが増える。** 使われていないキーを
 * 見つけて失効させる運用（§9 の「API キー漏洩」への備え）に要るので、
 * 費用を払う価値がある。**失敗しても認証は成立している**ので、
 * 呼び出し側は例外を握りつぶしてよい。
 */
export async function touchApiKeyLastUsed(
  env: Env,
  ctx: TenantContext,
  apiKeyId: string,
): Promise<void> {
  assertIdBelongsToTenant(apiKeyId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(apiKey)
    .set({ lastUsedAt: ctx.now })
    .where(withTenantScope(apiKey, ctx, NO_PROPERTY_SCOPE, eq(apiKey.id, apiKeyId)));
}
