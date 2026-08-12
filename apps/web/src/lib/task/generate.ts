/**
 * タスク自動生成の実行（PK-SPEC-P1 §3）。
 *
 * task: docs/tasks/P1-03.md
 *
 * ── 純粋な判断と副作用を分けてある ──────────────────────
 * 「何を作るか」は `packages/engine` の `planGeneration()`（DB を引かない）。
 * ここは**計画を読んで書き込むだけ。** ルールを変えたいときに触るのは
 * engine 側で、この層は変わらない。
 *
 * ── 冪等（§3.2 MUST）────────────────────────────────────
 * 3 段構えで守る。
 *   1. `planGeneration()` が着手済みを計画から外す
 *   2. リポジトリの UPDATE が `status` を条件に含める（計画〜適用の隙間）
 *   3. INSERT が一意制約 + `onConflictDoNothing()`
 * どれか 1 つでは足りない。1 だけでは並行実行に負け、3 だけでは
 * 着手済みタスクの優先度が書き換わる。
 */

import {
  cancelPlannedTasks,
  createTasks,
  expandChecklist,
  listRoomPlans,
  listRooms,
  listShortIds,
  listStandardTimes,
  listTasks,
  listTemplateItems,
  listTemplatesForProperty,
  reviveCancelledTasks,
  setHousekeepingStatus,
  updatePlannedTasks,
  type CreateTaskInput,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  housekeepingStatusFor,
  planGeneration,
  resolveTemplate,
  type ExistingTask,
  type GeneratedTaskType,
  type RoomPlanInput,
} from "@pk/engine";

import { nextShortId } from "./shortId.js";

/** 生成結果。**件数だけを返す。** */
export interface GenerateResult {
  created: number;
  updated: number;
  cancelled: number;
  revived: number;
}

/**
 * 1 施設 × 1 業務日ぶんのタスクを生成する。
 *
 * ── 客室状況が 1 件も無い施設 ───────────────────────────
 * **何も作らない。** §3.4 の「未入力でも動く」は、`dailyRoomPlan` を
 * 全室 `hasCheckout = true` で埋める操作（`/room-plans/all-checkout`）として
 * 用意してある。ここで暗黙に全室アウト清掃を作ると、入力を始めた施設で
 * 「入力していない客室にもタスクが立つ」ことになり、区別がつかなくなる。
 */
export async function generateTasksForProperty(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
): Promise<GenerateResult> {
  const [plans, rooms, existingTasks, standardTimes, shortIds] = await Promise.all([
    listRoomPlans(env, ctx, propertyId, businessDate),
    listRooms(env, ctx, { propertyId, isActive: true }),
    listTasks(env, ctx, { propertyId, businessDate }),
    listStandardTimes(env, ctx, propertyId),
    listShortIds(env, ctx, businessDate),
  ]);

  const roomById = new Map(rooms.map((room) => [room.id, room]));

  // 客室マスタに無い（または無効化された）客室の行は捨てる。客室を無効化した
  // あとも計画だけが残っているとタスクが立ち続ける。
  const inputs: RoomPlanInput[] = plans.flatMap((plan) => {
    const room = roomById.get(plan.roomId);
    if (room === undefined) return [];
    return [
      {
        roomId: plan.roomId,
        hasCheckout: plan.hasCheckout,
        hasCheckin: plan.hasCheckin,
        isStayover: plan.isStayover,
        declineClean: plan.declineClean,
        roomTypeId: room.roomTypeId,
      },
    ];
  });

  const existing: ExistingTask[] = existingTasks.map((task) => ({
    roomId: task.roomId,
    taskType: task.taskType,
    status: task.status,
    priority: task.priority,
    standardMinutes: task.standardMinutes,
  }));

  const minutesByKey = new Map(
    standardTimes.map((row) => [`${row.roomTypeId} ${row.taskType}`, row.minutes]),
  );
  const plan = planGeneration(inputs, existing, (roomTypeId, taskType) =>
    roomTypeId === null ? undefined : minutesByKey.get(`${roomTypeId} ${taskType}`),
  );

  const createInputs: CreateTaskInput[] = plan.create.map((desired) => ({
    propertyId,
    roomId: desired.roomId,
    businessDate,
    taskType: desired.taskType,
    priority: desired.priority,
    standardMinutes: desired.standardMinutes,
    shortId: nextShortId(shortIds),
  }));

  const createResult = await createTasks(env, ctx, createInputs);
  const updated = await updatePlannedTasks(env, ctx, businessDate, plan.update);
  const cancelled = await cancelPlannedTasks(env, ctx, businessDate, plan.cancel);
  const revived = await reviveCancelledTasks(env, ctx, businessDate, plan.revive);

  // タスクを作った客室を `DIRTY` にする（§11.1 の 1 行目 / P1-16）。
  // **作れた客室だけ。** 見送られた（既にある）客室まで戻すと、
  // 再生成のたびに作業中の客室が「未清掃」に戻る。
  const generated = housekeepingStatusFor("generate", false);
  if (generated !== null && createResult.createdInputs.length > 0) {
    await setHousekeepingStatus(
      env,
      ctx,
      [...new Set(createResult.createdInputs.map((input) => input.roomId))],
      generated,
    );
  }

  await expandChecklistsFor(env, ctx, propertyId, createResult.createdIds, createResult.createdInputs, roomById);

  return { created: createResult.created, updated, cancelled, revived };
}

/**
 * 作ったタスクへチェックリストを展開する（§6.1）。
 *
 * **展開できなくてもタスクの生成は成功とみなす。** テンプレートが 1 つも
 * 無い組織でも清掃は回る（§7 のリスク表）。ここで落とすと、テンプレートを
 * 作る前の施設でタスクが 1 件も立たない。
 */
async function expandChecklistsFor(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  createdIds: readonly string[],
  createdInputs: readonly CreateTaskInput[],
  roomById: Map<string, { roomTypeId: string | null }>,
): Promise<void> {
  if (createdIds.length === 0) return;

  const templates = await listTemplatesForProperty(env, ctx, propertyId);
  if (templates.length === 0) return;

  const items = await listTemplateItems(
    env,
    ctx,
    templates.map((template) => template.id),
  );
  const itemsByTemplate = new Map<string, typeof items>();
  for (const item of items) {
    const bucket = itemsByTemplate.get(item.templateId) ?? [];
    bucket.push(item);
    itemsByTemplate.set(item.templateId, bucket);
  }

  const expansions = createdIds.flatMap((taskId, index) => {
    const input = createdInputs[index];
    if (input === undefined) return [];
    const template = resolveTemplate(templates, {
      propertyId,
      roomTypeId: roomById.get(input.roomId)?.roomTypeId ?? null,
      taskType: input.taskType satisfies GeneratedTaskType,
    });
    if (template === null) return [];
    const templateItems = itemsByTemplate.get(template.id) ?? [];
    if (templateItems.length === 0) return [];
    return [
      {
        taskId,
        propertyId,
        templateVersion: template.version,
        items: templateItems.map((item) => ({
          itemId: item.id,
          isRequired: item.isRequired,
          photoRequired: item.photoRequired,
        })),
      },
    ];
  });

  await expandChecklist(env, ctx, expansions);
}
