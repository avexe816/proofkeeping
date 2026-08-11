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
