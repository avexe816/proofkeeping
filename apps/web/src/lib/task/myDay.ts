/**
 * 1 日の動線の組み立て（PK-SPEC-P1 §19.6）。
 *
 * task: docs/tasks/P1-21.md
 *
 * ── API と画面が同じものを組み立てる ────────────────────
 * `GET /api/v1/tasks/my-day`（`routes/api/v1/tasks.ts`）と M-02 の loader
 * （`routes/m/today.tsx`）の**両方がここを呼ぶ。** 片方だけ直る状態を
 * 作らない。オフラインのキャッシュは API の応答をそのまま保存するので、
 * 形が割れると復帰後に画面が壊れる（§19.7）。
 *
 * ── 担当者を引数に取らない ──────────────────────────────
 * `ctx` ではなく明示的に `membershipId` を受け取るが、**呼び出し側は
 * 必ずセッションの値を渡すこと。** クライアントから受け取った値を
 * 通す経路を作らない（INV-07。他人の 1 日が読める）。
 *
 * ── クエリは 4 本（§19.6 MUST の p95 400ms）──────────────
 * タスク・客室・施設・訪問順。**施設ごとにループしない。**
 * 3 施設 30 タスクでも 4 本のまま。
 */

import type { MyDayResponse, TaskSummary } from "@pk/contracts";
import {
  listDailyRoute,
  listProperties,
  listRooms,
  listTasks,
  type Env,
  type TenantContext,
} from "@pk/db";
import { buildMyDay, type MyDayTask } from "@pk/engine";

/** `buildMyDay()` に渡す形。`TaskSummary` に並べ替え用の項目を足しただけ。 */
interface MyDayRow extends MyDayTask {
  summary: TaskSummary;
}

/**
 * 担当者 1 人 × 1 業務日ぶんを組み立てる。
 *
 * @param membershipId **セッションの `membershipId`。** 引数で他人を指定しない。
 * @param now 応答を作った時刻。`fetchedAt` に載る（§19.7 の「取得時刻を明示」）。
 */
export async function buildMyDayResponse(
  env: Env,
  ctx: TenantContext,
  membershipId: string,
  businessDate: string,
  now: Date,
): Promise<MyDayResponse> {
  const [tasks, rooms, properties, route] = await Promise.all([
    listTasks(env, ctx, { businessDate, assigneeId: membershipId }),
    // **タスクごとに客室を引かない。** 1 回で引いて突き合わせる（§13）。
    listRooms(env, ctx, {}),
    listProperties(env, ctx, {}),
    listDailyRoute(env, ctx, membershipId, businessDate),
  ]);

  const roomById = new Map(rooms.map((room) => [room.id, room]));

  const rows: MyDayRow[] = tasks.map((task) => {
    const roomNumber = roomById.get(task.roomId)?.roomNumber ?? "";
    return {
      taskId: task.id,
      propertyId: task.propertyId,
      status: task.status,
      priority: task.priority,
      roomNumber,
      summary: {
        taskId: task.id,
        shortId: task.shortId,
        propertyId: task.propertyId,
        roomId: task.roomId,
        roomNumber,
        roomTypeName: null,
        businessDate: task.businessDate,
        taskType: task.taskType,
        status: task.status,
        priority: task.priority,
        assigneeId: task.assigneeId,
        standardMinutes: task.standardMinutes,
        actualMinutes: task.actualMinutes,
        pauseCount: task.pauseCount,
        startedAt: task.startedAt?.getTime() ?? null,
        completedAt: task.completedAt?.getTime() ?? null,
      },
    };
  });

  const day = buildMyDay(
    rows,
    properties.map((property) => ({
      propertyId: property.id,
      code: property.code,
      name: property.name,
    })),
    route.map((entry) => ({
      sequence: entry.sequence,
      propertyId: entry.propertyId,
      plannedStartAt: entry.plannedStartAt,
      plannedEndAt: entry.plannedEndAt,
      travelMinutes: entry.travelMinutes,
    })),
  );

  return {
    businessDate,
    fetchedAt: now.getTime(),
    propertyCount: day.propertyCount,
    totalTasks: day.totalTasks,
    summary: day.summary,
    groups: day.groups.map((group) => ({
      sequence: group.sequence,
      property: group.property,
      plannedStartAt: group.plannedStartAt,
      plannedEndAt: group.plannedEndAt,
      travelMinutesToNext: group.travelMinutesToNext,
      taskCount: group.taskCount,
      allDone: group.allDone,
      tasks: group.tasks.map((row) => row.summary),
    })),
  };
}
