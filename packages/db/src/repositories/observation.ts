/**
 * 観察記録・リネン記録・観察設定のリポジトリ（PK-SPEC-P3 §2）。
 *
 * task: docs/tasks/P3-03.md（記録）/ P3-06.md（リネン）/
 *       P3-07.md（事後修正）/ P3-11.md（施設設定）
 *
 * ── 消す関数を作らない ──────────────────────────────────
 * `db.delete(roomObservation)` / `db.delete(observationRevision)` を書かない。
 * 観察は P4 の照合の土台で、消えると差異の根拠そのものが無くなる。
 * 訂正は `amendObservation()`（旧値を `observationRevision` に積む）。
 * `repositories.spec.ts` がソースを走査して固定する。
 *
 * ── 判定を持ち込まない ──────────────────────────────────
 * 「異常」「疑い」を表す列も条件も無い（§0.2）。ここは数を出し入れするだけ。
 *
 * ── 冪等 ────────────────────────────────────────────────
 * `upsertObservation()` は `Idempotency-Key` を `roomObservation` の
 * `idempotencyKey` 列に持ち、同じ鍵の 2 回目を `unchanged` で返す（§7 MUST）。
 * **鍵の記録表を別に作っていない**（`taskTimeLog` と同じ判断 / DECISIONS #065）。
 */

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  linenRecord,
  observationConfig,
  observationRevision,
  roomObservation,
  type ItemCode,
  type TrashLevel,
} from "../schema/observation.js";
import { cleaningTask } from "../schema/task.js";

import { withTenantScope } from "./base.js";

// ────────────────────────────────────────────────────────────
// 観察記録（§2.1）
// ────────────────────────────────────────────────────────────

/** 数える項目（§2.1）。`packages/contracts` の `ObservationCounts` に対応する。 */
export interface ObservationCountsInput {
  bedsUsed: number;
  trashLevel: TrashLevel;
  bathTowelUsed: number;
  faceTowelUsed: number;
  handTowelUsed: number;
  bathMatUsed: number;
  slippersUsed: number;
  cupsUsed: number;
  extraFutonUsed: number;
  amenitiesUsed: Record<string, number | boolean>;
}

/** `upsertObservation()` の入力。**施設・客室・業務日は呼び出し側がタスクから解決する。** */
export interface UpsertObservationInput extends ObservationCountsInput {
  taskId: string;
  propertyId: string;
  roomId: string;
  roomTypeId: string;
  businessDate: string;
  note: string | null;
  inputDurationMs: number | null;
  usedDefaults: boolean;
  recordedById: string;
  clientTs: number | null;
  /** `Idempotency-Key` ヘッダ（§7 MUST）。無ければ `null`。 */
  idempotencyKey: string | null;
}

/** 記録の結果。`unchanged` は再送（同じ鍵）で何も変えなかったこと。 */
export interface UpsertObservationResult {
  observationId: string;
  unchanged: boolean;
}

/** 1 タスクの観察記録（`uq_obs_task` により 0 件か 1 件）。 */
export async function findObservationByTaskId(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(roomObservation)
    .where(
      withTenantScope(
        roomObservation,
        ctx,
        roomObservation.propertyId,
        eq(roomObservation.taskId, taskId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 1 件（事後修正の入口 / W-19 の詳細）。 */
export async function findObservationById(env: Env, ctx: TenantContext, observationId: string) {
  assertIdBelongsToTenant(observationId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(roomObservation)
    .where(
      withTenantScope(
        roomObservation,
        ctx,
        roomObservation.propertyId,
        eq(roomObservation.id, observationId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 一覧の絞り込み（§7 の `GET /observations?propertyId=&from=&to=`）。 */
export interface ObservationFilter {
  propertyId?: string | undefined;
  /** 業務日の下限（含む）。 */
  from?: string | undefined;
  /** 業務日の上限（含む）。 */
  to?: string | undefined;
  roomTypeId?: string | undefined;
}

/**
 * 一覧（W-19 / ベースライン算出の入力）。**新しい業務日から。**
 *
 * **担当者で絞る条件を作っていない。** 「誰の観察記録か」で並べる画面は
 * 個人の比較になる（security.md §5 / INV-07）。記録者は行に残るが、
 * それで引く口をリポジトリに置かない。
 */
export async function listObservations(
  env: Env,
  ctx: TenantContext,
  filter: ObservationFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(roomObservation)
    .where(
      withTenantScope(
        roomObservation,
        ctx,
        roomObservation.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(roomObservation.propertyId, filter.propertyId),
        filter.from === undefined ? undefined : gte(roomObservation.businessDate, filter.from),
        filter.to === undefined ? undefined : lte(roomObservation.businessDate, filter.to),
        filter.roomTypeId === undefined
          ? undefined
          : eq(roomObservation.roomTypeId, filter.roomTypeId),
      ),
    )
    .orderBy(desc(roomObservation.businessDate), desc(roomObservation.recordedAt));
}

/**
 * 入室時の観察を記録する（§2.1 / §7）。**1 タスク 1 行。**
 *
 * ── 同じ鍵の 2 回目は書かない ───────────────────────────
 * オフラインキューは同じ `Idempotency-Key` で再送する（§8）。既に
 * その鍵で入っていれば何もせず `unchanged: true` を返す。**行を増やさない
 * だけでなく、`observationRevision` にも積まない**（再送は「修正」ではない）。
 *
 * ── 上書きは履歴を残す ──────────────────────────────────
 * 別の鍵で同じタスクへ来たら上書きし、**旧値を `observationRevision` に
 * 積む**（§2.1 MUST）。現場の入力し直しは理由を聞かないので `reason` は
 * 定型文字列。理由必須なのは事後修正（`amendObservation()`）のほう。
 */
export async function upsertObservation(
  env: Env,
  ctx: TenantContext,
  input: UpsertObservationInput,
): Promise<UpsertObservationResult> {
  assertIdBelongsToTenant(input.taskId, ctx);
  assertIdBelongsToTenant(input.propertyId, ctx);
  assertIdBelongsToTenant(input.roomId, ctx);
  const db = await getTenantDb(env, ctx);

  const existing = await findObservationByTaskId(env, ctx, input.taskId);

  if (
    existing !== undefined &&
    input.idempotencyKey !== null &&
    existing.idempotencyKey === input.idempotencyKey
  ) {
    return { observationId: existing.id, unchanged: true };
  }

  const values = {
    bedsUsed: input.bedsUsed,
    trashLevel: input.trashLevel,
    bathTowelUsed: input.bathTowelUsed,
    faceTowelUsed: input.faceTowelUsed,
    handTowelUsed: input.handTowelUsed,
    bathMatUsed: input.bathMatUsed,
    slippersUsed: input.slippersUsed,
    cupsUsed: input.cupsUsed,
    extraFutonUsed: input.extraFutonUsed,
    amenitiesUsed: input.amenitiesUsed,
    note: input.note,
    inputDurationMs: input.inputDurationMs,
    usedDefaults: input.usedDefaults,
    recordedById: input.recordedById,
    recordedAt: ctx.now,
    clientTs: input.clientTs === null ? null : new Date(input.clientTs),
    idempotencyKey: input.idempotencyKey,
  };

  if (existing === undefined) {
    const id = generateId(ctx.orgShortId, "obs");
    await db.batch([
      db.insert(roomObservation).values({
        id,
        organizationId: ctx.organizationId,
        propertyId: input.propertyId,
        taskId: input.taskId,
        roomId: input.roomId,
        roomTypeId: input.roomTypeId,
        businessDate: input.businessDate,
        ...values,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      }),
      markTaskObserved(db, ctx, input.taskId),
    ]);
    return { observationId: id, unchanged: false };
  }

  await db.batch([
    db.insert(observationRevision).values({
      id: generateId(ctx.orgShortId, "orev"),
      organizationId: ctx.organizationId,
      propertyId: existing.propertyId,
      observationId: existing.id,
      revision: (await countRevisions(env, ctx, existing.id)) + 1,
      payload: JSON.stringify(snapshotOf(existing)),
      changedById: input.recordedById,
      changedAt: ctx.now,
      // 現場の入力し直し。**理由を聞かない**（§1.3 と同じ向き）。
      // 理由必須は事後修正（§2.2）の側で、そちらは `amendObservation()`。
      reason: "RECORDED_AGAIN",
    }),
    db
      .update(roomObservation)
      .set({ ...values, updatedAt: ctx.now })
      .where(
        and(
          eq(roomObservation.organizationId, ctx.organizationId),
          eq(roomObservation.id, existing.id),
        ),
      ),
    markTaskObserved(db, ctx, input.taskId),
  ]);

  return { observationId: existing.id, unchanged: false };
}

/**
 * 「今回は記録しない」（§1.3 MUST / §7）。
 *
 * **理由を受け取らない。** 記録しなかったこと自体だけを残す。
 * 既に記録があるタスクには何もしない（`unchanged: true`）。
 * 記録済みを「無かったこと」にする経路を作らないため。
 */
export async function skipObservation(
  env: Env,
  ctx: TenantContext,
  taskId: string,
): Promise<{ unchanged: boolean }> {
  assertIdBelongsToTenant(taskId, ctx);
  const existing = await findObservationByTaskId(env, ctx, taskId);
  if (existing !== undefined) return { unchanged: true };

  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(cleaningTask)
    .set({ observationSkipped: true, updatedAt: ctx.now })
    .where(
      and(
        eq(cleaningTask.organizationId, ctx.organizationId),
        eq(cleaningTask.id, taskId),
        eq(cleaningTask.observationSkipped, false),
      ),
    );

  return { unchanged: result.meta.changes === 0 };
}

/** `amendObservation()` の入力。**理由必須**（§2.2 MUST）。 */
export interface AmendObservationInput extends ObservationCountsInput {
  observationId: string;
  note: string | null;
  changedById: string;
  reason: string;
}

/**
 * 事後修正（§2.2 / P3-07）。**旧値を `observationRevision` に残す。**
 *
 * 権限（`PROPERTY_MANAGER` 以上）と監査ログは呼び出し側
 * （`lib/observation/amend.ts`）。ここは**旧値を必ず積む**ことだけを守る。
 *
 * **`usedDefaults` / `inputDurationMs` を書き換えない。** どちらも
 * 「現場が入力したときの事実」で、後から動かすと W-22 の入力品質
 * （§6.3）が別のものを指す。
 */
export async function amendObservation(
  env: Env,
  ctx: TenantContext,
  input: AmendObservationInput,
): Promise<{ applied: boolean }> {
  assertIdBelongsToTenant(input.observationId, ctx);
  const existing = await findObservationById(env, ctx, input.observationId);
  if (existing === undefined) return { applied: false };

  const db = await getTenantDb(env, ctx);
  await db.batch([
    db.insert(observationRevision).values({
      id: generateId(ctx.orgShortId, "orev"),
      organizationId: ctx.organizationId,
      propertyId: existing.propertyId,
      observationId: existing.id,
      revision: (await countRevisions(env, ctx, existing.id)) + 1,
      payload: JSON.stringify(snapshotOf(existing)),
      changedById: input.changedById,
      changedAt: ctx.now,
      reason: input.reason,
    }),
    db
      .update(roomObservation)
      .set({
        bedsUsed: input.bedsUsed,
        trashLevel: input.trashLevel,
        bathTowelUsed: input.bathTowelUsed,
        faceTowelUsed: input.faceTowelUsed,
        handTowelUsed: input.handTowelUsed,
        bathMatUsed: input.bathMatUsed,
        slippersUsed: input.slippersUsed,
        cupsUsed: input.cupsUsed,
        extraFutonUsed: input.extraFutonUsed,
        amenitiesUsed: input.amenitiesUsed,
        note: input.note,
        updatedAt: ctx.now,
      })
      .where(
        and(
          eq(roomObservation.organizationId, ctx.organizationId),
          eq(roomObservation.id, existing.id),
        ),
      ),
  ]);

  return { applied: true };
}

/** 修正履歴（§2.2）。**古い順。** 差異詳細画面（P4）が読む。 */
export async function listObservationRevisions(
  env: Env,
  ctx: TenantContext,
  observationId: string,
) {
  assertIdBelongsToTenant(observationId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(observationRevision)
    .where(
      withTenantScope(
        observationRevision,
        ctx,
        observationRevision.propertyId,
        eq(observationRevision.observationId, observationId),
      ),
    )
    .orderBy(observationRevision.revision);
}

// ────────────────────────────────────────────────────────────
// リネン記録（§2.3 / §4.3）
// ────────────────────────────────────────────────────────────

/** 1 タスクのリネン記録。**品目コード順。** */
export async function listLinenRecords(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(linenRecord)
    .where(
      withTenantScope(linenRecord, ctx, linenRecord.propertyId, eq(linenRecord.taskId, taskId)),
    )
    .orderBy(linenRecord.itemCode);
}

/**
 * 施設ごとのリネン枚数の合計（1 業務日）。
 *
 * P7-19 進捗モニタの列（人間の判断 2026-08-16: リネン消費は新規画面に
 * せず、進捗モニタの集計列として扱う / DECISIONS #195 の運用）。
 *
 * **rollup に列を足さない判断。** リネンは品目別の枚数で、rollup
 * （タスク数の集計）と粒度が違う。`idx_linen_date` が
 * (org, property, businessDate) で張ってあり、1 業務日の合計は索引
 * だけで引ける。行数は 客室数 × 品目数 が上限で、再計算方式の
 * rollup へ運ぶ利得が無い。
 *
 * **テナント内の集計であって、テナント横断ではない**（architecture.md §3
 * が禁じるのは横断）。`withTenantScope()` が organizationId を強制する。
 */
export async function sumLinenByProperty(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
): Promise<ReadonlyMap<string, { collectedQty: number; suppliedQty: number }>> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({
      propertyId: linenRecord.propertyId,
      collectedQty: sql<number>`sum(${linenRecord.collectedQty})`,
      suppliedQty: sql<number>`sum(${linenRecord.suppliedQty})`,
    })
    .from(linenRecord)
    .where(
      withTenantScope(
        linenRecord,
        ctx,
        linenRecord.propertyId,
        eq(linenRecord.businessDate, businessDate),
      ),
    )
    .groupBy(linenRecord.propertyId);

  return new Map(
    rows.map((row) => [
      row.propertyId,
      { collectedQty: row.collectedQty, suppliedQty: row.suppliedQty },
    ]),
  );
}

/**
 * 品目ごとのリネン枚数の合計（施設 1 件・期間）。
 *
 * 月次レポート（owner 09 / docs/PROTOTYPE_GAP.md 第2批 09）の §5 が読む。
 * `sumLinenByProperty()` の期間版で、分解軸が施設ではなく品目。
 * **テナント内・施設 1 件の集計であって、テナント横断ではない**
 * （`sumLinenByProperty()` の注記と同じ）。`idx_linen_date`
 * （org, property, businessDate）がそのまま効く。
 *
 * 並びは `itemCode` の辞書順。**表示の並び（品目マスタの定義順）は
 * 呼び出し側が決める**（この層に表示の都合を持ち込まない）。
 */
export async function sumLinenByItemInRange(
  env: Env,
  ctx: TenantContext,
  filter: LinenRangeFilter,
): Promise<readonly { itemCode: ItemCode; collectedQty: number; suppliedQty: number }[]> {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      itemCode: linenRecord.itemCode,
      collectedQty: sql<number>`sum(${linenRecord.collectedQty})`,
      suppliedQty: sql<number>`sum(${linenRecord.suppliedQty})`,
    })
    .from(linenRecord)
    .where(
      withTenantScope(
        linenRecord,
        ctx,
        linenRecord.propertyId,
        eq(linenRecord.propertyId, filter.propertyId),
        gte(linenRecord.businessDate, filter.from),
        lte(linenRecord.businessDate, filter.to),
      ),
    )
    .groupBy(linenRecord.itemCode)
    .orderBy(linenRecord.itemCode);
}

/** `listLinenRecordsInRange()` の絞り込み。 */
export interface LinenRangeFilter {
  propertyId: string;
  /** 業務日の下限（含む）。 */
  from: string;
  /** 業務日の上限（含む）。 */
  to: string;
}

/**
 * 期間内のリネン記録（ベースライン週次バッチ / P3-09）。
 *
 * 品目ごとの列を持たない品目（シーツ・枕カバー・浴衣）は、この表から
 * しか拾えない（`packages/engine` の `toObservationSamples()`）。
 * **タスク単位ではなく期間で引く**のはバッチのため。画面は
 * `listLinenRecords()`（1 タスクぶん）を使う。
 */
export async function listLinenRecordsInRange(
  env: Env,
  ctx: TenantContext,
  filter: LinenRangeFilter,
) {
  assertIdBelongsToTenant(filter.propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(linenRecord)
    .where(
      withTenantScope(
        linenRecord,
        ctx,
        linenRecord.propertyId,
        eq(linenRecord.propertyId, filter.propertyId),
        gte(linenRecord.businessDate, filter.from),
        lte(linenRecord.businessDate, filter.to),
      ),
    )
    .orderBy(linenRecord.businessDate, linenRecord.taskId, linenRecord.itemCode);
}

/** 品目 1 件ぶん。 */
export interface LinenEntryInput {
  itemCode: ItemCode;
  collectedQty: number;
  suppliedQty: number;
  damagedQty: number;
  stainedQty: number;
  note: string | null;
}

/** `upsertLinenRecords()` の入力。 */
export interface UpsertLinenRecordsInput {
  taskId: string;
  propertyId: string;
  roomId: string;
  businessDate: string;
  recordedById: string;
  entries: readonly LinenEntryInput[];
}

/**
 * リネン枚数をまとめて記録する（§2.3 / §7）。**冪等。**
 *
 * 一意制約 `(organizationId, taskId, itemCode)` への upsert。
 * **3 回送っても行が増えない**（testing.md §4）。オフラインキューからの
 * 再送は同じ値で上書きになるだけで、鍵を持たせていない
 * （観察記録と違い「前の値」に意味が無く、履歴を残す表も無いため）。
 */
export async function upsertLinenRecords(
  env: Env,
  ctx: TenantContext,
  input: UpsertLinenRecordsInput,
): Promise<number> {
  assertIdBelongsToTenant(input.taskId, ctx);
  assertIdBelongsToTenant(input.propertyId, ctx);
  assertIdBelongsToTenant(input.roomId, ctx);
  const db = await getTenantDb(env, ctx);

  let applied = 0;
  for (const entry of input.entries) {
    await db
      .insert(linenRecord)
      .values({
        id: generateId(ctx.orgShortId, "linen"),
        organizationId: ctx.organizationId,
        propertyId: input.propertyId,
        taskId: input.taskId,
        roomId: input.roomId,
        businessDate: input.businessDate,
        itemCode: entry.itemCode,
        collectedQty: entry.collectedQty,
        suppliedQty: entry.suppliedQty,
        damagedQty: entry.damagedQty,
        stainedQty: entry.stainedQty,
        note: entry.note,
        recordedById: input.recordedById,
        recordedAt: ctx.now,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [linenRecord.organizationId, linenRecord.taskId, linenRecord.itemCode],
        set: {
          collectedQty: entry.collectedQty,
          suppliedQty: entry.suppliedQty,
          damagedQty: entry.damagedQty,
          stainedQty: entry.stainedQty,
          note: entry.note,
          recordedById: input.recordedById,
          recordedAt: ctx.now,
          updatedAt: ctx.now,
        },
      });
    applied += 1;
  }
  return applied;
}

// ────────────────────────────────────────────────────────────
// 施設別の観察設定（§2.6 / W-20）
// ────────────────────────────────────────────────────────────

/** 施設の観察設定。**未設定なら `undefined`**（既定は呼び出し側が持つ）。 */
export async function findObservationConfig(env: Env, ctx: TenantContext, propertyId: string) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(observationConfig)
    .where(
      withTenantScope(
        observationConfig,
        ctx,
        observationConfig.propertyId,
        eq(observationConfig.propertyId, propertyId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 複数施設ぶん（W-22 / データ品質の一覧で使う）。 */
export async function listObservationConfigs(
  env: Env,
  ctx: TenantContext,
  propertyIds?: readonly string[],
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(observationConfig)
    .where(
      withTenantScope(
        observationConfig,
        ctx,
        observationConfig.propertyId,
        propertyIds === undefined || propertyIds.length === 0
          ? undefined
          : inArray(observationConfig.propertyId, [...propertyIds]),
      ),
    )
    .orderBy(observationConfig.propertyId);
}

/** `upsertObservationConfig()` の入力（§2.6）。 */
export interface UpsertObservationConfigInput {
  propertyId: string;
  enabled: boolean;
  requireBeds: boolean;
  requireTrash: boolean;
  requireTowels: boolean;
  requireAmenities: boolean;
  requireLinen: boolean;
  enabledItemCodes: readonly ItemCode[];
  skipWarnThreshold: number;
}

/** 施設の観察設定を保存する（W-20）。**1 施設 1 行の upsert。** */
export async function upsertObservationConfig(
  env: Env,
  ctx: TenantContext,
  input: UpsertObservationConfigInput,
): Promise<void> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const values = {
    enabled: input.enabled,
    requireBeds: input.requireBeds,
    requireTrash: input.requireTrash,
    requireTowels: input.requireTowels,
    requireAmenities: input.requireAmenities,
    requireLinen: input.requireLinen,
    enabledItemCodes: [...input.enabledItemCodes],
    skipWarnThreshold: input.skipWarnThreshold,
    updatedAt: ctx.now,
  };

  await db
    .insert(observationConfig)
    .values({
      id: generateId(ctx.orgShortId, "ocfg"),
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [observationConfig.organizationId, observationConfig.propertyId],
      set: values,
    });
}

// ────────────────────────────────────────────────────────────
// 内部
// ────────────────────────────────────────────────────────────

/** `roomObservation` の 1 行。 */
type ObservationRow = Awaited<ReturnType<typeof listObservations>>[number];

/**
 * 履歴に積む「変更前の全内容」（§2.2 の `payload`）。
 *
 * **ID と組織を含めない。** どの観察の履歴かは `observationId` 列にあり、
 * payload に混ぜると読む側が 2 つの真実を持つ。
 */
function snapshotOf(row: ObservationRow): Record<string, unknown> {
  return {
    bedsUsed: row.bedsUsed,
    trashLevel: row.trashLevel,
    bathTowelUsed: row.bathTowelUsed,
    faceTowelUsed: row.faceTowelUsed,
    handTowelUsed: row.handTowelUsed,
    bathMatUsed: row.bathMatUsed,
    slippersUsed: row.slippersUsed,
    cupsUsed: row.cupsUsed,
    extraFutonUsed: row.extraFutonUsed,
    amenitiesUsed: row.amenitiesUsed,
    note: row.note,
    inputDurationMs: row.inputDurationMs,
    usedDefaults: row.usedDefaults,
    recordedById: row.recordedById,
    recordedAt: row.recordedAt.getTime(),
  };
}

/** 既存の履歴の件数。次の `revision` を決める（`uq_obs_rev` を満たす）。 */
async function countRevisions(
  env: Env,
  ctx: TenantContext,
  observationId: string,
): Promise<number> {
  return (await listObservationRevisions(env, ctx, observationId)).length;
}

/**
 * タスク側に「観察を記録した」を書く文（§2.7）。
 *
 * **`observationSkipped` を偽へ戻す。** 一度スキップしてから記録し直す
 * 経路があり（M-05 の「今回は記録しない」→ 後でタスク詳細から入力）、
 * そこで印が残ると W-22 の未記録率が実態より高く出る。
 */
function markTaskObserved(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  ctx: TenantContext,
  taskId: string,
) {
  return db
    .update(cleaningTask)
    .set({
      observationSkipped: false,
      observationRecordedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(and(eq(cleaningTask.organizationId, ctx.organizationId), eq(cleaningTask.id, taskId)));
}
