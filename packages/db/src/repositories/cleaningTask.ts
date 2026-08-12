/**
 * 清掃タスクと作業時間ログのリポジトリ。
 *
 * task: docs/tasks/P1-01.md / docs/tasks/P1-03.md / docs/tasks/P1-05.md
 * 仕様: docs/PK-SPEC-P1.md §2.1 / §3.3 / §5
 *
 * ── この層が判断しないこと ──────────────────────────────
 * 状態遷移の可否（`packages/engine` の `evaluateTransition()`）、
 * 生成すべきタスクの決定（同 `planGeneration()`）、権限（`assertPermission()`）。
 * ここは**組織条件を必ず載せた読み書き**だけを持つ。
 *
 * ── 監査ログを書かない ──────────────────────────────────
 * `recordAudit()` は API ハンドラ（ユースケース層）が呼ぶ。
 * `repositories/audit.ts` の注記を参照。
 */

import { eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  cleaningTask,
  taskPhoto,
  taskTimeLog,
  type TaskSourceType,
  type TaskStatus,
  type TaskType,
  type TimeEvent,
} from "../schema/task.js";

import { withTenantScope } from "./base.js";

/** `listTasks()` の絞り込み。未指定の項目は条件に加えない。 */
export interface TaskFilter {
  /** **施設スコープの代わりにならない。** `withTenantScope()` と AND される。 */
  propertyId?: string | undefined;
  businessDate?: string | undefined;
  status?: readonly TaskStatus[] | undefined;
  /** 担当者（`membership.id`）。M-02（自分のタスク）で使う。 */
  assigneeId?: string | undefined;
}

/** 一覧。施設スコープロールには担当施設のタスクだけが返る。 */
export async function listTasks(env: Env, ctx: TenantContext, filter: TaskFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(cleaningTask)
    .where(
      withTenantScope(
        cleaningTask,
        ctx,
        cleaningTask.propertyId,
        filter.propertyId === undefined
          ? undefined
          : eq(cleaningTask.propertyId, filter.propertyId),
        filter.businessDate === undefined
          ? undefined
          : eq(cleaningTask.businessDate, filter.businessDate),
        filter.status === undefined || filter.status.length === 0
          ? undefined
          : inArray(cleaningTask.status, [...filter.status]),
        filter.assigneeId === undefined
          ? undefined
          : eq(cleaningTask.assigneeId, filter.assigneeId),
      ),
    );
}

/** タスク 1 件。越境 ID は DB へ行く前に `NotFoundError`（→ 404）。 */
export async function findTaskById(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(cleaningTask)
    .where(withTenantScope(cleaningTask, ctx, cleaningTask.propertyId, eq(cleaningTask.id, taskId)))
    .limit(1);
  return rows[0];
}

/**
 * 直リンク（`/t/{shortId}`）からタスクを引く。
 *
 * `shortId` は組織内で一意。**セッションの組織で必ず絞る**ので、
 * 他組織の 8 桁を当てても 0 件になる（§14.5）。
 */
export async function findTaskByShortId(env: Env, ctx: TenantContext, shortId: string) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(cleaningTask)
    .where(
      withTenantScope(cleaningTask, ctx, cleaningTask.propertyId, eq(cleaningTask.shortId, shortId)),
    )
    .limit(1);
  return rows[0];
}

/** `createTasks()` の 1 件ぶん。ID・組織・時刻は受け取らない。 */
export interface CreateTaskInput {
  propertyId: string;
  roomId: string;
  businessDate: string;
  taskType: TaskType;
  priority: number;
  standardMinutes: number;
  shortId: string;
  sourceType?: TaskSourceType | undefined;
}

/** `createTasks()` の結果。**既存はエラーにせず見送る。** */
export interface CreateTasksResult {
  created: number;
  skipped: number;
  /** 作成できた行の `id`。チェックリストの展開に使う。 */
  createdIds: readonly string[];
  /** `createdIds` と同じ並びの入力。 */
  createdInputs: readonly CreateTaskInput[];
}

/**
 * タスクをまとめて作る。
 *
 * 冪等: 一意制約 `(organizationId, roomId, businessDate, taskType)` と
 * `onConflictDoNothing()` により、**同じ入力で 3 回呼んでも 1 件しか増えない**
 * （§3.2 MUST / P1-03 完了条件）。
 */
export async function createTasks(
  env: Env,
  ctx: TenantContext,
  inputs: readonly CreateTaskInput[],
): Promise<CreateTasksResult> {
  const db = await getTenantDb(env, ctx);

  const createdIds: string[] = [];
  const createdInputs: CreateTaskInput[] = [];
  for (const input of inputs) {
    const id = generateId(ctx.orgShortId, "task");
    const result = await db
      .insert(cleaningTask)
      .values({
        id,
        organizationId: ctx.organizationId,
        propertyId: input.propertyId,
        roomId: input.roomId,
        businessDate: input.businessDate,
        taskType: input.taskType,
        status: "CREATED",
        priority: input.priority,
        standardMinutes: input.standardMinutes,
        shortId: input.shortId,
        sourceType: input.sourceType ?? "AUTO",
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoNothing();

    if (result.meta.changes > 0) {
      createdIds.push(id);
      createdInputs.push(input);
    }
  }

  return {
    created: createdIds.length,
    skipped: inputs.length - createdIds.length,
    createdIds,
    createdInputs,
  };
}

/** 未着手タスクの優先度・標準時間の更新（§3.3）。 */
export interface UpdatePlanInput {
  roomId: string;
  taskType: TaskType;
  priority: number;
  standardMinutes: number;
}

/**
 * 再生成で未着手タスクの優先度と標準時間だけを更新する。
 *
 * **着手済みに当たらないよう `status` を条件に含める。** 呼び出し側の
 * 計画（`planGeneration()`）でも除外しているが、計画を立ててから
 * 適用するまでの間に清掃員が着手しうる。二重に防ぐ。
 */
export async function updatePlannedTasks(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
  inputs: readonly UpdatePlanInput[],
): Promise<number> {
  const db = await getTenantDb(env, ctx);
  let updated = 0;

  for (const input of inputs) {
    const result = await db
      .update(cleaningTask)
      .set({ priority: input.priority, standardMinutes: input.standardMinutes, updatedAt: ctx.now })
      .where(
        withTenantScope(
          cleaningTask,
          ctx,
          cleaningTask.propertyId,
          eq(cleaningTask.roomId, input.roomId),
          eq(cleaningTask.businessDate, businessDate),
          eq(cleaningTask.taskType, input.taskType),
          inArray(cleaningTask.status, ["CREATED", "ASSIGNED", "BLOCKED"]),
        ),
      );
    updated += result.meta.changes;
  }

  return updated;
}

/**
 * 計画から消えた未着手タスクを取消す（§3.3 の `cancelOrphanedTasks`）。
 *
 * **物理削除しない。** 取消した事実が残らないと、再生成のたびに
 * 「無かったことになる」タスクが生まれ、証跡として使えなくなる。
 */
export async function cancelPlannedTasks(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
  targets: readonly { roomId: string; taskType: TaskType }[],
): Promise<number> {
  const db = await getTenantDb(env, ctx);
  let cancelled = 0;

  for (const target of targets) {
    const result = await db
      .update(cleaningTask)
      .set({ status: "CANCELLED", cancelledAt: ctx.now, updatedAt: ctx.now })
      .where(
        withTenantScope(
          cleaningTask,
          ctx,
          cleaningTask.propertyId,
          eq(cleaningTask.roomId, target.roomId),
          eq(cleaningTask.businessDate, businessDate),
          eq(cleaningTask.taskType, target.taskType),
          inArray(cleaningTask.status, ["CREATED", "ASSIGNED", "BLOCKED"]),
        ),
      );
    cancelled += result.meta.changes;
  }

  return cancelled;
}

/**
 * 取消済みのタスクを未割当へ戻す（§3.3 の再生成で計画に返り咲いた客室）。
 *
 * 一意制約があるため新しい行は作れない。**取消の履歴は
 * `updatedAt` と監査ログに残る。**
 */
export async function reviveCancelledTasks(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
  inputs: readonly UpdatePlanInput[],
): Promise<number> {
  const db = await getTenantDb(env, ctx);
  let revived = 0;

  for (const input of inputs) {
    const result = await db
      .update(cleaningTask)
      .set({
        status: "CREATED",
        cancelledAt: null,
        priority: input.priority,
        standardMinutes: input.standardMinutes,
        sourceType: "REGENERATED",
        updatedAt: ctx.now,
      })
      .where(
        withTenantScope(
          cleaningTask,
          ctx,
          cleaningTask.propertyId,
          eq(cleaningTask.roomId, input.roomId),
          eq(cleaningTask.businessDate, businessDate),
          eq(cleaningTask.taskType, input.taskType),
          eq(cleaningTask.status, "CANCELLED"),
        ),
      );
    revived += result.meta.changes;
  }

  return revived;
}

/** 状態変更で書き換える列。**呼び出し側が状態機械の判定を済ませていること。** */
export interface ApplyTransitionInput {
  status: TaskStatus;
  assigneeId?: string | null | undefined;
  assignedAt?: Date | null | undefined;
  startedAt?: Date | null | undefined;
  completedAt?: Date | null | undefined;
  cancelledAt?: Date | null | undefined;
  actualMinutes?: number | undefined;
  pauseCount?: number | undefined;
  blockedReason?: string | null | undefined;
  note?: string | undefined;
}

/**
 * 状態を進める。
 *
 * `expectedStatus` を条件に含める（楽観的排他）。**同じタスクへ 2 つの
 * 操作が同時に届いた場合、後から来た方は 0 行更新になる。** オフラインの
 * 再送が並列に着地しても、時間ログが二重に積まれない。
 *
 * @returns 更新できたら `true`。競合または該当なしなら `false`。
 */
export async function applyTransition(
  env: Env,
  ctx: TenantContext,
  taskId: string,
  expectedStatus: TaskStatus,
  input: ApplyTransitionInput,
): Promise<boolean> {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(cleaningTask)
    .set({
      status: input.status,
      ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
      ...(input.assignedAt === undefined ? {} : { assignedAt: input.assignedAt }),
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.cancelledAt === undefined ? {} : { cancelledAt: input.cancelledAt }),
      ...(input.actualMinutes === undefined ? {} : { actualMinutes: input.actualMinutes }),
      ...(input.pauseCount === undefined ? {} : { pauseCount: input.pauseCount }),
      ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
      ...(input.note === undefined ? {} : { note: input.note }),
      updatedAt: ctx.now,
    })
    .where(
      withTenantScope(
        cleaningTask,
        ctx,
        cleaningTask.propertyId,
        eq(cleaningTask.id, taskId),
        eq(cleaningTask.status, expectedStatus),
      ),
    );
  return result.meta.changes > 0;
}

/** タスク 1 件の時間ログ。**時刻の昇順。** */
export async function listTimeLogs(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(taskTimeLog)
    .where(withTenantScope(taskTimeLog, ctx, taskTimeLog.propertyId, eq(taskTimeLog.taskId, taskId)))
    .orderBy(taskTimeLog.occurredAt);
}

/** `appendTimeLog()` の入力。 */
export interface AppendTimeLogInput {
  taskId: string;
  propertyId: string;
  event: TimeEvent;
  actorId: string;
  reasonCode?: string | undefined;
  clientTs?: Date | undefined;
  /** `Idempotency-Key` ヘッダの値。同じ鍵の 2 回目は書かれない。 */
  idempotencyKey?: string | undefined;
}

/**
 * 時間ログを 1 件足す。**UPDATE / DELETE の関数は無い。**
 *
 * @returns 書けたら `true`。同じ `idempotencyKey` で既に書かれていれば `false`。
 */
export async function appendTimeLog(
  env: Env,
  ctx: TenantContext,
  input: AppendTimeLogInput,
): Promise<boolean> {
  assertIdBelongsToTenant(input.taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .insert(taskTimeLog)
    .values({
      id: generateId(ctx.orgShortId, "tlog"),
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      taskId: input.taskId,
      event: input.event,
      occurredAt: ctx.now,
      actorId: input.actorId,
      reasonCode: input.reasonCode ?? null,
      clientTs: input.clientTs ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: ctx.now,
    })
    .onConflictDoNothing();
  return result.meta.changes > 0;
}

/**
 * `Idempotency-Key` が既に使われているか。
 *
 * 再送を「何も起きなかった」に倒すために、**書き込みの前に見る。**
 * 時間ログを持たない操作（`assign` / `cancel`）でもここを通す。
 */
export async function findTimeLogByIdempotencyKey(
  env: Env,
  ctx: TenantContext,
  idempotencyKey: string,
) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(taskTimeLog)
    .where(
      withTenantScope(
        taskTimeLog,
        ctx,
        taskTimeLog.propertyId,
        eq(taskTimeLog.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * 施設・業務日ごとのタスク件数を状態別に数える（W-03 / M-10 の客室ボード）。
 *
 * **これは「タスクテーブルへの直接集計」にあたる。** architecture.md §3 が
 * rollup を使えと定めるのは**施設をまたぐ集計**で、これは施設 1 件・
 * 業務日 1 日の内訳。`dailyPropertyRollup` は 1 施設 1 行しか持たず、
 * 状態別の内訳を持たない（OPEN_QUESTIONS #029）。
 */
export async function countTasksByStatus(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
): Promise<Map<string, number>> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ status: cleaningTask.status, count: sql<number>`count(*)` })
    .from(cleaningTask)
    .where(
      withTenantScope(
        cleaningTask,
        ctx,
        cleaningTask.propertyId,
        eq(cleaningTask.propertyId, propertyId),
        eq(cleaningTask.businessDate, businessDate),
      ),
    )
    .groupBy(cleaningTask.status);
  return new Map(rows.map((row) => [row.status, row.count]));
}

/**
 * その業務日に既に使われている `shortId`。
 *
 * 8 桁の採番は組織内で衝突しうる。**採番側が既存を避けられるように
 * 一覧を返す**（`createTasks()` は一意制約で弾くだけなので、
 * 衝突したタスクが静かに作られない状態になる）。
 */
export async function listShortIds(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
): Promise<Set<string>> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ shortId: cleaningTask.shortId })
    .from(cleaningTask)
    .where(
      withTenantScope(
        cleaningTask,
        ctx,
        cleaningTask.propertyId,
        eq(cleaningTask.businessDate, businessDate),
      ),
    );
  return new Set(rows.map((row) => row.shortId));
}

/** 担当者を変更する（§4.2 の一括変更）。**監査は呼び出し側。** */
export async function assignTasks(
  env: Env,
  ctx: TenantContext,
  taskIds: readonly string[],
  assigneeId: string | null,
): Promise<number> {
  for (const taskId of taskIds) assertIdBelongsToTenant(taskId, ctx);
  if (taskIds.length === 0) return 0;

  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(cleaningTask)
    .set({
      assigneeId,
      assignedAt: assigneeId === null ? null : ctx.now,
      status: assigneeId === null ? "CREATED" : "ASSIGNED",
      updatedAt: ctx.now,
    })
    .where(
      withTenantScope(
        cleaningTask,
        ctx,
        cleaningTask.propertyId,
        inArray(cleaningTask.id, [...taskIds]),
        inArray(cleaningTask.status, ["CREATED", "ASSIGNED"]),
      ),
    );
  return result.meta.changes;
}

/** 1 タスクの写真枚数を項目ごとに数える（`complete` の写真必須判定）。 */
export async function countPhotosByChecklistItem(
  env: Env,
  ctx: TenantContext,
  taskId: string,
): Promise<Map<string, number>> {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ checklistItemId: taskPhoto.checklistItemId, count: sql<number>`count(*)` })
    .from(taskPhoto)
    .where(
      withTenantScope(
        taskPhoto,
        ctx,
        taskPhoto.propertyId,
        eq(taskPhoto.taskId, taskId),
        isNotNull(taskPhoto.checklistItemId),
      ),
    )
    .groupBy(taskPhoto.checklistItemId);

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.checklistItemId === null) continue;
    counts.set(row.checklistItemId, row.count);
  }
  return counts;
}
