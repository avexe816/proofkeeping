/**
 * 外部連携（`integration` / `syncLog` / `externalMapping`）のリポジトリ。
 *
 * task: docs/tasks/P6-01.md / docs/tasks/P6-04.md
 * 仕様: docs/PK-SPEC-P6.md §2.1〜§2.3 / §4.2
 * ルール: .claude/rules/security.md §7 / .claude/rules/architecture.md §2
 *
 * ── 資格情報を返す関数が無い ────────────────────────────
 * この層が返すのは `credentialRef` / `webhookSecretRef`（KV の参照キー）まで。
 * **復号は `apps/web/src/lib/integration/credentials.ts` の仕事**で、
 * リポジトリは KV を触らない。行を丸ごと監査ログへ流しても平文は出ない。
 *
 * ── 失敗を状態として持つ ────────────────────────────────
 * 連携の失敗は例外ではなく「その日の稼働記録が未取得」という状態
 * （§1.2）。`markIntegrationSynced()` は失敗でも例外を投げず、
 * `consecutiveFailures` を積むだけ。**サーキットブレーカー（5 回で
 * `status = ERROR`）の判断は P6-07** で、ここは数えるところまで。
 *
 * ── 未マッピングをエラーにしない ────────────────────────
 * `resolveExternalIds()` は引けなかった外部 ID を落として返す。
 * **例外を投げない**（§2.3 MUST）。呼び出し側が `recordsSkipped` に数え、
 * W-13 が「未マッピング N 件」として見せる。
 */

import { desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  externalMapping,
  integration,
  syncLog,
  type ExternalEntityType,
  type IntegrationKind,
  type IntegrationStatus,
  type SyncDirection,
  type SyncStatus,
  type SyncTrigger,
} from "../schema/integration.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

// ────────────────────────────────────────────────────────────
// 連携設定（§2.1）
// ────────────────────────────────────────────────────────────

/** `listIntegrations()` の絞り込み。 */
export interface IntegrationFilter {
  kind?: IntegrationKind | undefined;
  status?: readonly IntegrationStatus[] | undefined;
}

/**
 * 連携の一覧（W-13 / §7.1）。
 *
 * 施設スコープロールには `propertyId` が自分の担当施設の行しか見えない。
 * **組織全体の連携（`propertyId = null`）も見えない。** 連携設定は
 * `OWNER` / `ORG_ADMIN` の画面（§7.1）で、施設スコープロールが読む場面が無い。
 * 見えなさすぎる方向の誤りなので、権限判定（`assertPermission`）を
 * 呼び出し側から外す口実にはしないこと。
 */
export async function listIntegrations(
  env: Env,
  ctx: TenantContext,
  filter: IntegrationFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(integration)
    .where(
      withTenantScope(
        integration,
        ctx,
        integration.propertyId,
        filter.kind === undefined ? undefined : eq(integration.kind, filter.kind),
        filter.status === undefined || filter.status.length === 0
          ? undefined
          : inArray(integration.status, [...filter.status]),
      ),
    )
    .orderBy(integration.kind, integration.displayName, integration.id);
}

/** 連携 1 件。**無ければ `undefined`**（越境 ID は先に `NotFoundError`）。 */
export async function findIntegrationById(env: Env, ctx: TenantContext, integrationId: string) {
  assertIdBelongsToTenant(integrationId, ctx);
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select()
    .from(integration)
    .where(
      withTenantScope(
        integration,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(integration.id, integrationId),
      ),
    )
    .limit(1);
  return row;
}

/** `createIntegration()` の入力。**資格情報そのものを受け取らない。** */
export interface CreateIntegrationInput {
  propertyId: string | null;
  kind: IntegrationKind;
  vendorCode: string;
  displayName: string;
  /** 接続設定。**秘密を入れない**（`schema/integration.ts` の注記）。 */
  config?: Record<string, unknown> | undefined;
  /** `CREDENTIALS` KV の参照キー。値そのものではない。 */
  credentialRef?: string | null | undefined;
  /** 受信署名鍵の参照キー。同上。 */
  webhookSecretRef?: string | null | undefined;
  syncMode?: "PULL" | "PUSH" | "BOTH" | undefined;
  syncCron?: string | null | undefined;
}

/**
 * 連携を作る。**初期状態は `INACTIVE`。**
 *
 * 接続テストに通ってから `ACTIVE` にする（§7.1 の「接続する」）。
 * 作った直後に取込が走らないようにするため、既定を `ACTIVE` にしない。
 */
export async function createIntegration(
  env: Env,
  ctx: TenantContext,
  input: CreateIntegrationInput,
) {
  if (input.propertyId !== null) assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const row = {
    id: generateId(ctx.orgShortId, "intg"),
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    kind: input.kind,
    vendorCode: input.vendorCode,
    displayName: input.displayName,
    status: "INACTIVE" as const,
    config: input.config ?? {},
    credentialRef: input.credentialRef ?? null,
    webhookSecretRef: input.webhookSecretRef ?? null,
    syncMode: input.syncMode ?? ("PULL" as const),
    syncCron: input.syncCron ?? null,
    consecutiveFailures: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await db.insert(integration).values(row);
  return row;
}

/** `markIntegrationSynced()` の入力。 */
export interface MarkIntegrationSyncedInput {
  integrationId: string;
  ok: boolean;
  /** 失敗理由。**外部システムの応答をそのまま入れない**（個人情報が混ざりうる）。 */
  errorMessage?: string | null | undefined;
}

/**
 * 同期の結果を連携へ書き戻す（§3.3 の 8 / §7.1 の「最終同期時刻」）。
 *
 * 成功で `consecutiveFailures` を 0 に戻し、失敗で 1 増やす。
 * **`status` をここで動かさない。** 5 回でサーキットブレーカーを開くのは
 * P6-07 の責務で、この関数は数えるところまで（§3.4）。
 *
 * 冪等ではない（呼ぶたびに数が動く）。**1 回の同期につき 1 回だけ呼ぶこと。**
 */
export async function markIntegrationSynced(
  env: Env,
  ctx: TenantContext,
  input: MarkIntegrationSyncedInput,
): Promise<void> {
  assertIdBelongsToTenant(input.integrationId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(integration)
    .set(
      input.ok
        ? {
            lastSyncAt: ctx.now,
            lastSuccessAt: ctx.now,
            consecutiveFailures: 0,
            updatedAt: ctx.now,
          }
        : {
            lastSyncAt: ctx.now,
            lastErrorAt: ctx.now,
            lastErrorMessage: input.errorMessage ?? null,
            consecutiveFailures: sql`${integration.consecutiveFailures} + 1`,
            updatedAt: ctx.now,
          },
    )
    .where(
      withTenantScope(
        integration,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(integration.id, input.integrationId),
      ),
    );
}

// ────────────────────────────────────────────────────────────
// 同期ログ（§2.2）
// ────────────────────────────────────────────────────────────

/** `startSyncLog()` の入力。 */
export interface StartSyncLogInput {
  integrationId: string;
  direction: SyncDirection;
  trigger: SyncTrigger;
  /** `YYYY-MM-DD`。webhook 受信のように対象日が定まらないときは `null`。 */
  targetDate?: string | null | undefined;
}

/**
 * 同期の開始を記録する。**必ず `finishSyncLog()` と対にする。**
 *
 * 開始時点では結果が分からないので `status = FAILED` で置く。
 * **「走ったが終わらなかった」を成功に見せない**ため。処理の途中で
 * Worker が落ちても、W-24（§7.3）には失敗として残る。
 */
export async function startSyncLog(env: Env, ctx: TenantContext, input: StartSyncLogInput) {
  assertIdBelongsToTenant(input.integrationId, ctx);
  const db = await getTenantDb(env, ctx);
  const row = {
    id: generateId(ctx.orgShortId, "slog"),
    organizationId: ctx.organizationId,
    integrationId: input.integrationId,
    direction: input.direction,
    trigger: input.trigger,
    targetDate: input.targetDate ?? null,
    status: "FAILED" as const,
    recordsReceived: 0,
    recordsApplied: 0,
    recordsSkipped: 0,
    recordsFailed: 0,
    startedAt: ctx.now,
  };
  await db.insert(syncLog).values(row);
  return row;
}

/** `finishSyncLog()` の入力。 */
export interface FinishSyncLogInput {
  syncLogId: string;
  status: SyncStatus;
  recordsReceived?: number | undefined;
  recordsApplied?: number | undefined;
  /** 未マッピングはここ。**エラーではない**（§2.3 MUST）。 */
  recordsSkipped?: number | undefined;
  recordsFailed?: number | undefined;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  /**
   * 先頭 3 件まで。**呼び出し側でマスク済みであること**（security.md §3）。
   * この層は中身を見ない（`occupancy.ts` の `rawPayload` と同じ扱い）。
   */
  rawSample?: unknown[] | null | undefined;
  /** 開始時刻。`durationMs` の計算に使う。 */
  startedAt: Date;
}

/** 同期ログを閉じる。 */
export async function finishSyncLog(
  env: Env,
  ctx: TenantContext,
  input: FinishSyncLogInput,
): Promise<void> {
  assertIdBelongsToTenant(input.syncLogId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(syncLog)
    .set({
      status: input.status,
      recordsReceived: input.recordsReceived ?? 0,
      recordsApplied: input.recordsApplied ?? 0,
      recordsSkipped: input.recordsSkipped ?? 0,
      recordsFailed: input.recordsFailed ?? 0,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      rawSample: input.rawSample ?? null,
      finishedAt: ctx.now,
      durationMs: ctx.now.getTime() - input.startedAt.getTime(),
    })
    .where(withTenantScope(syncLog, ctx, NO_PROPERTY_SCOPE, eq(syncLog.id, input.syncLogId)));
}

/** `listSyncLogs()` の絞り込み（W-24 / §7.3）。 */
export interface SyncLogFilter {
  integrationId?: string | undefined;
  limit?: number | undefined;
}

/** 同期ログの一覧。**新しい順。** */
export async function listSyncLogs(env: Env, ctx: TenantContext, filter: SyncLogFilter = {}) {
  if (filter.integrationId !== undefined) assertIdBelongsToTenant(filter.integrationId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(syncLog)
    .where(
      withTenantScope(
        syncLog,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.integrationId === undefined
          ? undefined
          : eq(syncLog.integrationId, filter.integrationId),
      ),
    )
    .orderBy(desc(syncLog.startedAt), desc(syncLog.id))
    .limit(Math.min(filter.limit ?? 50, 200));
}

/**
 * `rawSample` を落とす（security.md §3 の「保持 7 日」）。
 *
 * **行そのものは消さない。** 同期の履歴は W-24 が読む運用の記録で、
 * 保持 7 日が掛かるのは中に個人情報が混ざりうる `rawSample` だけ。
 *
 * 冪等。**2 回呼んでも結果が変わらない**（既に `null` の行は更新されるが
 * 値は変わらない）。
 */
export async function purgeSyncLogRawSamples(
  env: Env,
  ctx: TenantContext,
  before: Date,
): Promise<void> {
  const db = await getTenantDb(env, ctx);
  await db
    .update(syncLog)
    .set({ rawSample: null })
    .where(
      withTenantScope(
        syncLog,
        ctx,
        NO_PROPERTY_SCOPE,
        lte(syncLog.startedAt, before),
        // 既に落ちている行を触らない。更新件数がそのまま「今回消した数」になる。
        sql`${syncLog.rawSample} is not null`,
      ),
    );
}

// ────────────────────────────────────────────────────────────
// マッピング（§2.3）
// ────────────────────────────────────────────────────────────

/** `listExternalMappings()` の絞り込み（W-23 / §7.2）。 */
export interface ExternalMappingFilter {
  integrationId: string;
  entityType?: ExternalEntityType | undefined;
  /** 無効化した対応も含めるか。既定は有効なものだけ。 */
  includeInactive?: boolean | undefined;
}

/** 対応表の一覧。 */
export async function listExternalMappings(
  env: Env,
  ctx: TenantContext,
  filter: ExternalMappingFilter,
) {
  assertIdBelongsToTenant(filter.integrationId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(externalMapping)
    .where(
      withTenantScope(
        externalMapping,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(externalMapping.integrationId, filter.integrationId),
        filter.entityType === undefined
          ? undefined
          : eq(externalMapping.entityType, filter.entityType),
        filter.includeInactive === true ? undefined : eq(externalMapping.isActive, true),
      ),
    )
    .orderBy(externalMapping.externalId, externalMapping.id);
}

/**
 * 外部 ID を内部 ID へ引く。
 *
 * **引けなかった外部 ID は結果に現れない。例外を投げない**（§2.3 MUST）。
 * 呼び出し側は `externalIds.length - result.size` を `recordsSkipped` に数える。
 *
 * 無効化した対応（`isActive = false`）は引かない。機器を入れ替えたあとに
 * 古い対応で取り込み続ける事故を防ぐ。
 */
export async function resolveExternalIds(
  env: Env,
  ctx: TenantContext,
  params: {
    integrationId: string;
    entityType: ExternalEntityType;
    externalIds: readonly string[];
  },
): Promise<Map<string, string>> {
  assertIdBelongsToTenant(params.integrationId, ctx);
  const unique = [...new Set(params.externalIds)];
  if (unique.length === 0) return new Map();

  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({
      externalId: externalMapping.externalId,
      internalId: externalMapping.internalId,
    })
    .from(externalMapping)
    .where(
      withTenantScope(
        externalMapping,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(externalMapping.integrationId, params.integrationId),
        eq(externalMapping.entityType, params.entityType),
        eq(externalMapping.isActive, true),
        inArray(externalMapping.externalId, unique),
      ),
    );
  return new Map(rows.map((row) => [row.externalId, row.internalId]));
}

/** `upsertExternalMappings()` の 1 件ぶん。 */
export interface ExternalMappingInput {
  entityType: ExternalEntityType;
  internalId: string;
  externalId: string;
  externalLabel?: string | null | undefined;
}

/** `upsertExternalMappings()` の結果。 */
export interface UpsertExternalMappingsResult {
  inserted: number;
  /** 既に同じ対応があったので触らなかった数。**再実行はここに寄る。** */
  unchanged: number;
}

/**
 * 対応を登録する。**自動マッピングの再実行で行が増えない**（§7.2 の「実行」）。
 *
 * 既にある対応（外部 ID 側で一致）は触らない。手で直した対応
 * （`305 ←→ 0305`）を自動マッピングが上書きしないため。
 * `uq_map_ext` / `uq_map_int` の両方に当たらない組み合わせだけを入れる。
 */
export async function upsertExternalMappings(
  env: Env,
  ctx: TenantContext,
  integrationId: string,
  inputs: readonly ExternalMappingInput[],
): Promise<UpsertExternalMappingsResult> {
  assertIdBelongsToTenant(integrationId, ctx);
  if (inputs.length === 0) return { inserted: 0, unchanged: 0 };
  for (const input of inputs) assertIdBelongsToTenant(input.internalId, ctx);

  const db = await getTenantDb(env, ctx);
  const existingRows = await db
    .select({
      entityType: externalMapping.entityType,
      internalId: externalMapping.internalId,
      externalId: externalMapping.externalId,
    })
    .from(externalMapping)
    .where(
      withTenantScope(
        externalMapping,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(externalMapping.integrationId, integrationId),
      ),
    );

  // 内部 ID 側・外部 ID 側の両方で既存を弾く（`uq_map_int` / `uq_map_ext`）。
  const takenInternal = new Set(existingRows.map((row) => `${row.entityType} ${row.internalId}`));
  const takenExternal = new Set(existingRows.map((row) => `${row.entityType} ${row.externalId}`));

  const rows = [];
  let unchanged = 0;
  for (const input of inputs) {
    const internalKey = `${input.entityType} ${input.internalId}`;
    const externalKey = `${input.entityType} ${input.externalId}`;
    // **同じ呼び出しの中で同じ鍵が 2 度来ても 1 行しか作らない。**
    if (takenInternal.has(internalKey) || takenExternal.has(externalKey)) {
      unchanged += 1;
      continue;
    }
    takenInternal.add(internalKey);
    takenExternal.add(externalKey);
    rows.push({
      id: generateId(ctx.orgShortId, "xmap"),
      organizationId: ctx.organizationId,
      integrationId,
      entityType: input.entityType,
      internalId: input.internalId,
      externalId: input.externalId,
      externalLabel: input.externalLabel ?? null,
      isActive: true,
      createdAt: ctx.now,
    });
  }

  if (rows.length > 0) await db.insert(externalMapping).values(rows);
  return { inserted: rows.length, unchanged };
}

/**
 * 対応を無効化する。**行は消さない。**
 *
 * 過去の同期ログが「この外部 ID をこの客室へ入れた」根拠として参照する。
 * 消すと、取り込み済みのデータの由来が辿れなくなる。
 */
export async function deactivateExternalMapping(
  env: Env,
  ctx: TenantContext,
  mappingId: string,
): Promise<void> {
  assertIdBelongsToTenant(mappingId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(externalMapping)
    .set({ isActive: false })
    .where(
      withTenantScope(
        externalMapping,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(externalMapping.id, mappingId),
      ),
    );
}

/**
 * 有効な対応を持たない外部 ID を数える。W-13 の「未マッピング N 件」（§7.1）。
 *
 * **`sync_log` から数えない。** あちらは「その回に落ちた件数」で、
 * 直近の 1 回しか映さない。ここは対応表そのものを見る。
 */
export async function countUnmappedExternalIds(
  env: Env,
  ctx: TenantContext,
  params: {
    integrationId: string;
    entityType: ExternalEntityType;
    externalIds: readonly string[];
  },
): Promise<number> {
  const resolved = await resolveExternalIds(env, ctx, params);
  const unique = new Set(params.externalIds);
  let unmapped = 0;
  for (const externalId of unique) {
    if (!resolved.has(externalId)) unmapped += 1;
  }
  return unmapped;
}

/**
 * 対応の付いていない内部 ID（客室）を引く。W-23 の右端「未マッピング」（§7.2）。
 *
 * `internalIds` は呼び出し側が `room` から取る。**ここで `room` を
 * JOIN しない**（対応表の責務を越える）。
 */
export async function listMappedInternalIds(
  env: Env,
  ctx: TenantContext,
  params: { integrationId: string; entityType: ExternalEntityType },
): Promise<Set<string>> {
  assertIdBelongsToTenant(params.integrationId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ internalId: externalMapping.internalId })
    .from(externalMapping)
    .where(
      withTenantScope(
        externalMapping,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(externalMapping.integrationId, params.integrationId),
        eq(externalMapping.entityType, params.entityType),
        eq(externalMapping.isActive, true),
      ),
    );
  return new Set(rows.map((row) => row.internalId));
}

/**
 * 施設に紐づかない連携（`propertyId = null`）を引く。
 *
 * `listIntegrations()` は施設スコープロールで組織全体の連携を落とすため、
 * **組織全体の連携だけを狙って引く経路**を別に置く。Queue コンシューマ
 * （組織全体ロールの文脈）から使う。
 */
export async function listOrgWideIntegrations(
  env: Env,
  ctx: TenantContext,
  kind: IntegrationKind,
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(integration)
    .where(
      withTenantScope(
        integration,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(integration.kind, kind),
        isNull(integration.propertyId),
      ),
    )
    .orderBy(integration.displayName, integration.id);
}
