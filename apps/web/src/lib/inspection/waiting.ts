/**
 * 検査待ち一覧の組み立て（PK-SPEC-P2 §5.2 / §5.3 / §11.2）。
 *
 * task: docs/tasks/P2-05.md
 *
 * ── 並びの規則は engine にある ──────────────────────────
 * `sortInspectionQueue()`（`packages/engine`）。ここは**材料を集めるだけ。**
 * 画面（M-08）と API（`GET /inspections/waiting`）が同じ並びになるよう、
 * どちらもこの関数を通す。
 *
 * ── チェックイン予定時刻の列がまだ無い ──────────────────
 * §5.3 は「当日チェックイン予定時刻まで 30 分未満のタスクは緊急」と定め、
 * 「`DailyRoomPlan` に時刻が無い場合は `Property.checkInTime` を使う」と
 * 書くが、**どちらの列も存在しない**（`dailyRoomPlan` は `hasCheckin` の
 * 真偽だけ / OPEN_QUESTIONS #045）。`checkInAtMs` に `null` を渡している。
 * **規則は engine 側に実装してテストしてある。** 列ができたら 1 行差せば効く。
 *
 * `hasCheckin` を「緊急」に読み替えていないのは意図。チェックアウト主体の
 * 施設では大半の部屋にチェックインが立ち、**全件が緊急になって印が死ぬ。**
 */

import type { InspectionWaitingItem, InspectionWaitingResponse } from "@pk/contracts";
import {
  findInspectionPolicy,
  listRooms,
  listTasks,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  sortInspectionQueue,
  summarizeInspectionQueue,
  type WaitingInspection,
} from "@pk/engine";

/** 既定の SLA（分）。`propertyInspectionPolicy` の行が無い施設で使う。 */
export const DEFAULT_INSPECTION_SLA_MINUTES = 20;

/**
 * 施設 1 件・業務日 1 日の検査待ちを並べる。
 *
 * **権限判定は呼び出し側。** ここは絞り込みだけを行う（リポジトリ層の
 * `scopeToProperties()` が担当外施設を落とす）。
 */
export async function buildWaitingList(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
  now: Date,
): Promise<InspectionWaitingResponse> {
  const [tasks, rooms, policy] = await Promise.all([
    listTasks(env, ctx, { propertyId, businessDate, status: ["AWAITING_INSPECTION"] }),
    listRooms(env, ctx, { propertyId }),
    findInspectionPolicy(env, ctx, propertyId),
  ]);

  const slaMinutes = policy?.inspectionSlaMinutes ?? DEFAULT_INSPECTION_SLA_MINUTES;
  const roomById = new Map(rooms.map((room) => [room.id, room]));

  const entries: WaitingInspection[] = tasks.map((task) => ({
    taskId: task.id,
    roomNumber: roomById.get(task.roomId)?.roomNumber ?? "",
    completedAtMs: task.completedAt?.getTime() ?? null,
    // 冒頭の注記（OPEN_QUESTIONS #045）。列ができたらここを差し替える。
    checkInAtMs: null,
    completedRounds: task.currentInspectionRound,
  }));

  const queued = sortInspectionQueue(entries, now.getTime(), slaMinutes);

  const data: InspectionWaitingItem[] = queued.map((row) => ({
    taskId: row.taskId,
    roomNumber: row.roomNumber,
    tone: row.tone,
    waitedMinutes: row.waitedMinutes,
    minutesToCheckIn: row.minutesToCheckIn,
    slaMinutes,
    isOverSla: row.isOverSla,
    isRecheck: row.isRecheck,
    nextRound: row.completedRounds + 1,
    completedAt: row.completedAtMs,
  }));

  return { businessDate, summary: summarizeInspectionQueue(queued), data };
}
