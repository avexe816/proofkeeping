// Drizzle スキーマ・リポジトリ層・シャードルーターの置き場。実体は P0-06 / P0-07 で追加する。

// シャードルーター（P0-03）。アプリケーションコードが使ってよいのは `getTenantDb()` のみ。
// `shardIndexOf` / `fnv1a32` は明示マッピングを見ないため、通常の経路では使わない。
export {
  fnv1a32,
  getShardBinding,
  getTenantDb,
  resolveShard,
  shardIndexOf,
  type TenantContext,
} from "./router.js";

// ID 採番（P0-05）。テナント分離の第 2 層。ID を受け取ったら DB 問い合わせ前に
// `assertIdBelongsToTenant()` を通すこと（一元化は P0-10 の withResourceGuard）。
export {
  ENTITY_PREFIXES,
  ORG_SHORT_ID_ALPHABET,
  ORG_SHORT_ID_LENGTH,
  ORG_SHORT_ID_MAX_ATTEMPTS,
  ULID_LENGTH,
  assertIdBelongsToTenant,
  createUlidFactory,
  generateId,
  generateOrgShortId,
  parseId,
  ulid,
  type EntityPrefix,
  type GenerateOrgShortIdOptions,
  type OrgShortIdTaken,
  type ParsedId,
  type RandomBytes,
  type UlidFactoryDeps,
} from "./id.js";

// エラー（P0-05）。HTTP への写像は呼び出し側（P0-10）の責務。
// 後続 task はこれを再定義せず再エクスポートで取り込むこと。
export { NotFoundError } from "./errors.js";

// Workers の binding 定義（P0-02）。router.ts が `Env` を受け取るため db 側に置いている。
export type {
  BucketBindings,
  Env,
  EnvSecrets,
  EnvVars,
  KvBindings,
  QueueBindings,
  ShardBindings,
} from "./env.js";
