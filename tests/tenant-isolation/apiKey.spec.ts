/**
 * tenant isolation: api_key
 *
 * task:  docs/tasks/P6-12.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── この表が効く理由 ────────────────────────────────────
 * **他組織の行が 1 件混ざると、他社のデータへ届く鍵が自社の画面に出る。**
 * 一覧に混ざるだけでも `keyPrefix` とスコープが漏れ、失効の操作が
 * 他社の鍵に当たれば、動いている連携を止められる。
 *
 * ── 認証経路そのものも見る ──────────────────────────────
 * `findApiKeyByHash()` は**トークンから組み立てた文脈**で引く
 * （`lib/auth/apiKey.ts`）。組織短縮 ID はトークンに埋まっているので、
 * A 社のトークンで B 社の鍵を引くことは通常起きない。ここで押さえるのは
 * 「万一 B 社の文脈で引いても A 社の行が返らない」という第 1 層の側で、
 * `uq_api_key_hash` が `(organizationId, keyHash)` である
 * ——**ハッシュだけでは一意でない**——ことの裏返し。
 *
 * ── 施設スコープが掛からない ────────────────────────────
 * `api_key` は `propertyId` 列を持たない（§6.1）。施設の制限は
 * `propertyIds`（JSON 列）で表し、絞り込むのは**鍵を使う側**
 * （`middleware/apiKey.ts` が `allowedPropertyIds` へ写す）。
 * よって第 4 パターンは `propertyColumn: null` として扱う。
 */

import { findApiKeyByHash, listApiKeys, revokeApiKey } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "api_key",
  list: (env, ctx) => listApiKeys(env, ctx),
  // 失効は ID を取る唯一の経路。**越境 ID は DB へ行く前に 404。**
  findById: (env, ctx, id) => revokeApiKey(env, ctx, id),
  entityPrefix: "akey",
  propertyColumn: null,
});

/**
 * 認証の照会（ハッシュ引き）にも組織条件が載ること。
 *
 * **表としては同じ `api_key`** だが、経路が違う（ID ではなくハッシュで引く）。
 * `describeTenantIsolation()` を 2 回呼んで、`list` にこちらを渡す。
 */
describeTenantIsolation({
  table: "api_key（ハッシュ引き）",
  list: (env, ctx) => findApiKeyByHash(env, ctx, "0".repeat(64)),
  propertyColumn: null,
});
