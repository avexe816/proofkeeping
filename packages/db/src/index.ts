// Drizzle スキーマ・リポジトリ層・シャードルーターの置き場。実体は P0-06 / P0-07 で追加する。

// シャードルーター（P0-03）。アプリケーションコードが使ってよいのは `getTenantDb()` のみ。
// `shardIndexOf` / `fnv1a32` は明示マッピングを見ないため、通常の経路では使わない。
export {
  fnv1a32,
  getGlobalDb,
  getShardBinding,
  getTenantDb,
  resolveShard,
  shardIndexOf,
  type ShardContext,
  type TenantContext,
} from "./router.js";

// リポジトリ層（P0-07）。テナント分離の第 1 層。
// **アプリケーションコードは db から直に select しない。ここを通す。**
export * from "./repositories/index.js";

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

// エラー（P0-05 / P0-12）。HTTP への写像は呼び出し側（P0-10）の責務。
// 後続 task はこれを再定義せず再エクスポートで取り込むこと。
export { NotFoundError, PaymentRequiredError } from "./errors.js";

// ヘルスチェック（P0-20）。**返すのは件数と真偽だけ。シャード番号を含めない。**
export {
  checkHealth,
  type HealthReport,
  type HealthState,
  type ShardHealth,
} from "./health.js";

// シードデータ（P0-18）。ハッシュ化は注入で受ける（apps/web が渡す）。
export {
  SEED_CLEANER_COUNT,
  SEED_ORG_SHORT_ID,
  SEED_OWNER_STAFF_NUMBER,
  seed,
  type SeedCredentials,
  type SeedDeps,
  type SeedResult,
} from "./seed.js";

// 既定のチェックリストテンプレート 2 種（P1-06 / PK-SPEC-P1 §6.2）。
export {
  SEED_CHECKLIST_TEMPLATES,
  type SeedChecklistItem,
  type SeedChecklistTemplate,
} from "./seedChecklists.js";

// 監査ログのマスク（P0-11）。`recordAudit()` が内側で使う。
// 呼び出し側が事前にマスクする必要は無いが、ログ出力など別経路でも使える。
export { MASKED, maskSensitive, serializeAuditPayload } from "./mask.js";

// Drizzle スキーマ（P0-06）。テナントスコープの表のみ。
// 全局テーブル（org_directory）は `getGlobalDb()` 経由でしか引けない。
export * from "./schema/index.js";
export { schemaVersion } from "./schema/meta.js";

// orgShortId の全局レジストリ（P0-06）。組織作成の手順は orgDirectory.ts の冒頭を読むこと。
export {
  createOrgShortIdTaken,
  listOrganizationDirectory,
  lookupOrganizationId,
  reserveOrgShortId,
  type OrganizationDirectoryEntry,
  type ReserveOrgShortIdInput,
} from "./orgDirectory.js";

// マイグレーションランナー（P0-06）。CLI の入口は scripts/db-migrate.ts。
export {
  SCHEMA_VERSION_DDL,
  buildRecordSql,
  computeChecksum,
  planPending,
  runMigrations,
  type AppliedMigration,
  type MigrateDeps,
  type MigrateOptions,
  type MigrateResult,
  type MigrationSource,
  type ShardStatus,
  type ShardTarget,
} from "./migrate.js";

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
