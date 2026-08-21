// Drizzle スキーマ・リポジトリ層・シャードルーターの置き場。実体は P0-06 / P0-07 で追加する。

// シャードルーター（P0-03）。アプリケーションコードが使ってよいのは `getTenantDb()` のみ。
// `shardIndexOf` / `fnv1a32` は明示マッピングを見ないため、通常の経路では使わない。
export {
  fnv1a32,
  getGlobalDb,
  getPlatformDb,
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

// 年次アーカイブの対象と除外（P7-08 / PK-SPEC-P0 §19.7）。**純粋。**
// **知らない表は既定で退避しない**（`archivePolicy.ts` の注記）。
export {
  ARCHIVABLE_TABLES,
  ARCHIVE_RETENTION_MONTHS,
  DIRECTLY_ARCHIVABLE_TABLES,
  EXCLUSION_REASONS,
  EXPLICIT_EXCLUSIONS,
  ARCHIVE_RESTORE_MAX_CONCURRENT,
  ARCHIVE_RESTORE_MAX_MONTHS,
  ARCHIVE_RESTORE_RETENTION_DAYS,
  ARCHIVE_RESTORE_ROW_LIMIT,
  archiveCutoffBusinessDate,
  archiveObjectKey,
  archiveRestoreExpiresAt,
  isRestoreViewable,
  parseJsonl,
  restoreYearsOf,
  validateRestoreRange,
  exclusionReasonOf,
  isArchivable,
  isDirectlyArchivable,
  toJsonl,
  type ArchivableTable,
  type ArchiveEntry,
  type DirectlyArchivableTable,
  type ArchiveRestoreRejection,
  type ExclusionReason,
} from "./archivePolicy.js";

// シャードの使用率と警告レベル（P7-06 / PK-SPEC-P7 §4.3）。
// **運用者向け。テナント向けの API・画面から呼ばないこと**
// （シャード番号を持つ / CLAUDE.md §4・`shardUsage.ts` の注記）。
export {
  SHARD_CAPACITY_BYTES,
  SHARD_USAGE_CRITICAL_RATIO,
  SHARD_USAGE_INFO_RATIO,
  SHARD_USAGE_LEVELS,
  SHARD_USAGE_WARNING_RATIO,
  formatBytes,
  formatUsageRatio,
  needsAction,
  shardUsageLevelOf,
  worstLevelOf,
  type ShardUsageLevel,
} from "./shardUsage.js";

export {
  collectShardUsage,
  type ShardUsage,
  type ShardUsageReport,
} from "./shardUsageCollector.js";

// テナント移送の照合（P7-07 / PK-SPEC-P7 §4.4）。**純粋。**
// **運用者向け。テナント向けの API・画面から呼ばないこと**（同上）。
export {
  NON_MOVABLE_TABLES,
  TENANT_MOVE_STEPS,
  TENANT_MOVE_STEP_LABELS,
  assertShardMapValue,
  canonicalRow,
  checksumOfRows,
  isMovableTable,
  mayProceedAfterVerify,
  movableTablesOf,
  shardMapKey,
  verifyTenantMove,
  type TableMismatch,
  type TableSnapshot,
  type TenantMoveStep,
  type TenantMoveVerification,
} from "./tenantMove.js";

// バッチが監査ログを書くときの操作者（P7-10 / PK-SPEC-P7 §4.5）。**純粋。**
// **`membership` の行ではない**（DECISIONS #164）。
export { isSystemActorId, systemActorId } from "./systemActor.js";

// D1 の 1 文あたりバインド変数上限（100）と、それに収める分割。
// **「SQLite の 999」で分割の大きさを決めないこと**（limits.ts の注記）。
export { D1_MAX_BOUND_PARAMS, chunkByParamBudget, chunkIdsForInArray } from "./limits.js";

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
export { checkHealth, type HealthReport, type HealthState, type ShardHealth } from "./health.js";

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

// プラットフォーム運営の表（PF-01 / DECISIONS #220）。**全局（SHARD_00）。**
// `schema/index.ts` に載せない — あちらはテナントスコープの表だけで、
// `schema.spec.ts` が organization_id と index の不変条件をそこに掛けている。
// **この表は `getPlatformDb()` からしか引けない。**
export {
  PLATFORM_OPERATOR_STATUSES,
  platformAuditLog,
  platformBootstrapToken,
  platformOperationSetting,
  platformOperator,
  platformRecoveryCode,
  platformTenantSnapshot,
  type PlatformOperatorStatus,
} from "./schema/platform.js";

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
