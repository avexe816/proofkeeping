/**
 * 公開 API の認証（PK-SPEC-P6 §6.1 / §6.2 / §6.5 / P6-12）。
 *
 * task:  docs/tasks/P6-12.md
 * ルール: .claude/rules/security.md §7・§8 / .claude/rules/architecture.md §1
 *
 * ```
 * Authorization: Bearer pk_live_{orgShortId}_{secret}
 *   → 組織短縮 ID を取り出す（トークンの形から）
 *     → org_directory → organizationId → シャード
 *       → api_key を keyHash で引く
 *         → 失効・期限 → レート制限 → TenantContext を組む
 * ```
 *
 * ── セッション middleware と併用しない ──────────────────
 * 公開 API は Cookie を持たない。**`useTenantMiddleware()` を付けないこと。**
 * `session` / `tenant` の組み立て方が違うだけで、下流（リポジトリ層）から
 * 見た `TenantContext` の形は同じになる。
 *
 * ── `role` は権限判定に使わない ─────────────────────────
 * 公開 API の認可は**スコープ**（§6.2）で決まる。`TenantContext.role` に
 * 入れているのは、**リポジトリ層の施設スコープを効かせるためだけ**の値。
 *
 *   `propertyIds = null` → `ORG_ADMIN`（組織全体 / `isOrgWideRole`）
 *   `propertyIds = [..]` → `PROPERTY_MANAGER` ＋ `allowedPropertyIds`
 *
 * **公開エンドポイントで `assertPermission()` を呼ばないこと**
 * （docs/DECISIONS.md #151）。呼ぶと、施設を絞ったキーが
 * `PROPERTY_MANAGER` の権限をそのまま名乗ることになる。
 * `routes/api/v1/public/public.spec.ts` がソースを走査して固定している。
 *
 * ── 失敗の理由を返さない ────────────────────────────────
 * キーが存在しないのか、失効したのか、期限切れなのか、スコープが
 * 足りないのかを**認証の段階では区別しない。** すべて 401。
 * 区別すると、生きているキーの探索ができる（INV-31 / `integrationWebhooks.ts`
 * と同じ）。**スコープ不足だけは 403** で返す（§8.4 の受け入れ基準
 * 「スコープ外のエンドポイントで 403 になる」）。認証は通っている以上、
 * リソースの存在は既に呼び出し元に知られている。
 */

import {
  findApiKeyByHash,
  lookupOrganizationId,
  touchApiKeyLastUsed,
  type ApiScope,
  type Env,
  type TenantContext,
} from "@pk/db";
import type { Context, MiddlewareHandler } from "hono";

import {
  allowedPropertyIdsOf,
  hasScope,
  hashApiKeyToken,
  isApiKeyUsable,
  orgShortIdOfToken,
  readBearerToken,
  type ApiScopeValue,
} from "../lib/auth/apiKey.js";
import { consumeRateLimit, type RateLimitBucket } from "../lib/auth/rateLimit.js";

import { ContextMissingError, type AppEnv } from "./context.js";

/** リクエストに紐づく API キーの情報。**平文のトークンを持たない。** */
export interface ApiKeyContext {
  apiKeyId: string;
  scopes: readonly ApiScope[];
  /** `null` = 組織全体。配列 = その施設だけ。 */
  propertyIds: readonly string[] | null;
}

/** Hono の変数名。**セッション系と混ぜない。** */
const API_KEY_VAR = "apiKey";

/** 公開 API の文脈を持つアプリ。 */
export type PublicApiEnv = {
  Bindings: Env;
  Variables: AppEnv["Variables"] & { [API_KEY_VAR]?: ApiKeyContext };
};

/** API キーの文脈を取り出す。**middleware より後でのみ使える。** */
export function getApiKey(c: Context<PublicApiEnv>): ApiKeyContext {
  const value = c.get(API_KEY_VAR);
  if (value === undefined) throw new ContextMissingError("API_KEY");
  return value;
}

/** 401。**理由を載せない**（上の注記）。 */
function unauthorized(c: Context<PublicApiEnv>) {
  return c.json({ error: "UNAUTHORIZED" as const }, 401);
}

/**
 * `Authorization: Bearer` を検証して `TenantContext` を組む。
 *
 * **`now` もここで決める。** 公開 API は session middleware を通らないので、
 * 時刻の起点がここになる（`integrationWebhooks.ts` と同じ）。
 */
export function apiKeyMiddleware(): MiddlewareHandler<PublicApiEnv> {
  return async (c, next) => {
    const now = new Date();

    const token = readBearerToken(c.req.raw);
    if (token === null) return unauthorized(c);

    const orgShortId = orgShortIdOfToken(token);
    if (orgShortId === null) return unauthorized(c);

    // §6.5: 公開 API 全般 600 req/分/キー。**キーを引く前に掛ける。**
    // 識別子はトークンのハッシュ。**平文をレート制限の鍵にしない**
    // （KV のキー名としてログや管理画面に現れうる）。
    const keyHash = await hashApiKeyToken(token);
    const limited = await consumeRateLimit(c.env, "publicApi", keyHash, now);
    if (!limited.allowed) {
      return c.json({ error: "RATE_LIMITED" as const }, 429, {
        "Retry-After": String(limited.retryAfterSeconds),
      });
    }

    const organizationId = await lookupOrganizationId(c.env, orgShortId);
    if (organizationId === null) return unauthorized(c);

    // キーを引くための最小の文脈。**この時点では施設スコープを持たない**
    // （`api_key` は施設列を持たないので `NO_PROPERTY_SCOPE`）。
    const lookupCtx: TenantContext = {
      organizationId,
      orgShortId,
      role: "ORG_ADMIN",
      allowedPropertyIds: [],
      now,
    };

    const key = await findApiKeyByHash(c.env, lookupCtx, keyHash);
    if (key === undefined) return unauthorized(c);
    if (!isApiKeyUsable(key, now)) return unauthorized(c);

    const propertyIds = key.propertyIds;
    const tenant: TenantContext = {
      organizationId,
      orgShortId,
      // **権限判定には使わない**（上の注記 / DECISIONS #151）。
      role: propertyIds === null ? "ORG_ADMIN" : "PROPERTY_MANAGER",
      allowedPropertyIds: allowedPropertyIdsOf(propertyIds),
      now,
    };

    c.set("now", now);
    c.set("tenant", tenant);
    c.set(API_KEY_VAR, {
      apiKeyId: key.id,
      scopes: key.scopes,
      propertyIds,
    });

    // §6.1 の `lastUsedAt`。**失敗しても認証は成立している。**
    try {
      await touchApiKeyLastUsed(c.env, lookupCtx, key.id);
    } catch {
      console.error("api-key-touch-failed");
    }

    await next();
    return;
  };
}

/**
 * スコープを要求する（§6.2）。
 *
 * **足りなければ 403**（§8.4 の受け入れ基準）。認証は通っているので、
 * 401 と区別してよい。
 */
export function requireScope(scope: ApiScopeValue): MiddlewareHandler<PublicApiEnv> {
  return async (c, next) => {
    if (!hasScope(getApiKey(c).scopes, scope)) {
      return c.json({ error: "FORBIDDEN" as const, requiredScope: scope }, 403);
    }
    await next();
    return;
  };
}

/**
 * エンドポイント固有のレート制限（§6.5）。
 *
 * 全般の 600 req/分は `apiKeyMiddleware()` が掛けている。ここは
 * `occupancy/snapshots`（60）と `signals`（300）の**上乗せ。**
 */
export function requireEndpointRateLimit(
  bucket: RateLimitBucket,
): MiddlewareHandler<PublicApiEnv> {
  return async (c, next) => {
    const { apiKeyId } = getApiKey(c);
    const now = c.get("now") ?? new Date();
    const limited = await consumeRateLimit(c.env, bucket, apiKeyId, now);
    if (!limited.allowed) {
      return c.json({ error: "RATE_LIMITED" as const }, 429, {
        "Retry-After": String(limited.retryAfterSeconds),
      });
    }
    await next();
    return;
  };
}

/**
 * キーが施設を絞っているとき、その施設かを確かめる（§8.4 の
 * 「`propertyIds` 制限が機能する」）。
 *
 * **リポジトリ層の絞り込みと二重に効く。** あちらは一覧から落とすが、
 * 「1 件を名指しで取る」経路では 404 を返す必要がある（403 は存在を
 * 示唆する / architecture.md §2 第 2 層）。
 */
export function isPropertyAllowed(key: ApiKeyContext, propertyId: string): boolean {
  return key.propertyIds === null || key.propertyIds.includes(propertyId);
}
