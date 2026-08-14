/**
 * タスク一覧の 1 件を応答の形へ写す（PK-SPEC-P1 §9.2 の `taskSummarySchema`）。
 *
 * task: docs/tasks/P5-13.md（`routes/api/v1/tasks.ts` から切り出した）
 *
 * ── なぜ切り出したか ────────────────────────────────────
 * §6.3 の証跡ドリルダウン（請求明細 → 対象タスク一覧）が、タスク API と
 * **同じ形の一覧**を返す必要がある。形が違うと、画面が請求から来た一覧と
 * M-02 から来た一覧で別々の描画を持つことになる。写経すると片方だけ列が
 * 増えて静かにずれる。
 *
 * ── 客室をタスクごとに引かない ──────────────────────────
 * 客室番号は画面が必ず要る（M-02 は部屋番号で並ぶ）が、1 件ずつ引くと
 * 100 件の一覧で 100 クエリになる。1 回引いて突き合わせる。
 */

import type { TaskSummary } from "@pk/contracts";
import { listRooms, type Env, type TenantContext, type listTasks } from "@pk/db";

/** `listTasks()` / `listTasksByIds()` が返す 1 行。 */
export type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];

/**
 * 一覧の応答へ写す。
 *
 * **チェックリストの進捗を載せない。** タスクごとに 1 クエリ増える
 * （`taskSummarySchema` の注記）。要るのは詳細画面で、そちらは
 * `/tasks/{id}/checklist` を引く。
 */
export async function toTaskSummaries(
  env: Env,
  ctx: TenantContext,
  rows: readonly TaskRow[],
): Promise<TaskSummary[]> {
  if (rows.length === 0) return [];

  const rooms = await listRooms(env, ctx, {});
  const roomById = new Map(rooms.map((room) => [room.id, room]));

  return rows.map((task) => ({
    taskId: task.id,
    shortId: task.shortId,
    propertyId: task.propertyId,
    roomId: task.roomId,
    roomNumber: roomById.get(task.roomId)?.roomNumber ?? "",
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
  }));
}
