/**
 * 検査待ちのまま取り残されたタスクの一覧（PK-SPEC-P2 §13.3）。
 *
 * task: docs/tasks/P2-16.md
 *
 * ── M-08（`/waiting`）では見つからない ──────────────────
 * 検査待ち一覧は**その日の**検査待ちを並べる（§5.2）。移行で問題になるのは
 * 「いつのものか分からない古い検査待ち」なので、業務日で絞らない口を分けた。
 * 並び順も違う（M-08 は SLA と緊急度、こちらは古い順）。
 *
 * ── 施設の検査方式を一緒に返す ──────────────────────────
 * `NONE` の施設に残った検査待ちは**二度と検査されない。** 検査担当が
 * 割り当てられず、M-08 にも出ない（出たとしても検査する人が居ない）。
 * 上書き（`overrideInspection()`）の判断材料になるので応答に載せる。
 * `ALL` / `SAMPLE` の施設の残存は、まず通常の検査で片付ける
 * （§13.3 の「施設責任者が処理してから移行する」）。
 */

import type { StrandedTask, StrandedTaskListResponse } from "@pk/contracts";
import {
  findInspectionPolicy,
  findPropertyById,
  legacyPolicyValues,
  listRooms,
  listTasks,
  type Env,
  type TenantContext,
} from "@pk/db";

/**
 * 施設 1 件の取り残しを、古い順に並べる。
 *
 * **権限判定は呼び出し側。** ここは絞り込みだけを行う（リポジトリ層の
 * `scopeToProperties()` が担当外施設を落とす）。
 */
export async function buildStrandedList(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
): Promise<StrandedTaskListResponse> {
  const [tasks, rooms, policy, property] = await Promise.all([
    listTasks(env, ctx, { propertyId, status: ["AWAITING_INSPECTION"] }),
    listRooms(env, ctx, { propertyId }),
    findInspectionPolicy(env, ctx, propertyId),
    findPropertyById(env, ctx, propertyId),
  ]);

  // 行が無い施設は移行が届いていない（`repositories/inspectionPolicy.ts` の
  // 注記）。**既定の `ALL` で埋めない。** P1 の設定から組み立てる。
  const mode = policy?.mode ?? legacyPolicyValues(property?.inspectionRequired ?? false).mode;
  const roomById = new Map(rooms.map((room) => [room.id, room]));

  const data: StrandedTask[] = tasks
    .map((task) => ({
      taskId: task.id,
      roomNumber: roomById.get(task.roomId)?.roomNumber ?? "",
      businessDate: task.businessDate,
      completedAt: task.completedAt?.getTime() ?? null,
      completedRounds: task.currentInspectionRound,
    }))
    // 古い順。**業務日が同じなら客室番号順**（並びを決定的にする。
    // 同着を放置すると、画面を開き直すたびに順序が入れ替わる）。
    .sort(
      (a, b) =>
        a.businessDate.localeCompare(b.businessDate) || a.roomNumber.localeCompare(b.roomNumber),
    );

  return { mode, data };
}
