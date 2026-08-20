/**
 * 人員配分の適用（PK-SPEC-P1 §4.2）。W-04 の loader / action が使う。
 *
 * task: docs/tasks/P1-14.md
 *
 * ── 判断は engine、書き込みはここ ───────────────────────
 * 誰に何件配るか（§4.1）は `planAutoAssignment()`（DB を引かない）。
 * ここは**盤面を読んで書くだけ。** 自動配分の規則を変えたいときに触るのは
 * engine 側で、この層は変わらない（`lib/task/generate.ts` と同じ形）。
 *
 * ── 3 つとも欠けてはいけない ────────────────────────────
 *   1. 権限（施設は**タスクから解決する** / INV-32）
 *   2. 作業中の引き継ぎは確認を取ってから（§4.2）
 *   3. 変更は `AuditLog` に `task.assigned` として残す（§4.2）
 */

import {
  assignTasks,
  findPropertyById,
  listFloors,
  listPropertyStaff,
  listRooms,
  listTasks,
  recordAudit,
  NotFoundError,
  type Env,
  type PropertyStaff,
  type TenantContext,
} from "@pk/db";
import {
  planAutoAssignment,
  summarizeUnassigned,
  summarizeWorkload,
  sortTasksForAssignment,
  WORKLOAD_LIMIT_MINUTES,
  type AssignableTask,
  type WorkloadRow,
} from "@pk/engine";

import { assertPermission, propertyTarget } from "../auth/permission.js";
import { listAssignmentBlockedMembershipIds } from "../staff/assignmentBlock.js";

/** W-04 が描くのに要る盤面。**担当者の表示名の出し分けは画面の責務。** */
export interface AssignmentBoard {
  propertyId: string;
  businessDate: string;
  staff: readonly PropertyStaff[];
  tasks: readonly AssignableTask[];
  loads: readonly WorkloadRow[];
  unassigned: { taskCount: number; minutes: number };
  limitMinutes: number;
  /**
   * 新規配分を止めるスタッフ（在留資格の期限切れ / P8-02）。
   * **一覧からは消さない** — 既存の割当と負荷は見えたままにし、
   * 新しく配ることだけを止める。画面はこの ID にバッジを付ける。
   */
  blockedMembershipIds: readonly string[];
}

/** 盤面を読む。**権限は施設の資源として判定する。** */
export async function loadAssignmentBoard(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
): Promise<AssignmentBoard> {
  const property = await findPropertyById(env, ctx, propertyId);
  if (property === undefined) throw new NotFoundError();
  assertPermission(ctx, "task.manage", propertyTarget([property.id]));

  const [rows, rooms, floors, staff, blocked] = await Promise.all([
    listTasks(env, ctx, { propertyId, businessDate }),
    listRooms(env, ctx, { propertyId }),
    listFloors(env, ctx, propertyId),
    listPropertyStaff(env, ctx, propertyId),
    // 在留資格の期限切れ（P8-02）。**その日の業務日で判定する。**
    listAssignmentBlockedMembershipIds(env, ctx, businessDate),
  ]);

  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const floorOrderById = new Map(floors.map((row) => [row.id, row.sortOrder]));

  const tasks: AssignableTask[] = sortTasksForAssignment(
    rows
      .filter((task) => task.status !== "CANCELLED")
      .map((task) => {
        const room = roomById.get(task.roomId);
        const floorId = room?.floorId ?? null;
        return {
          taskId: task.id,
          roomNumber: room?.roomNumber ?? "",
          floorOrder: floorId === null ? null : (floorOrderById.get(floorId) ?? null),
          priority: task.priority,
          standardMinutes: task.standardMinutes,
          status: task.status,
          assigneeId: task.assigneeId,
        };
      }),
  );

  return {
    propertyId: property.id,
    businessDate,
    staff,
    tasks,
    loads: summarizeWorkload(tasks, staff),
    unassigned: summarizeUnassigned(tasks),
    limitMinutes: WORKLOAD_LIMIT_MINUTES,
    blockedMembershipIds: [...blocked],
  };
}

/**
 * 自動配分の提案を作る（§4.1）。**DB を書かない。**
 *
 * 画面はこれをプレビューとして出し、確定操作で `applyAssignments()` を呼ぶ。
 */
export function previewAutoAssignment(board: AssignmentBoard): {
  pairs: readonly { taskId: string; membershipId: string }[];
  loads: readonly WorkloadRow[];
  unassignedTaskIds: readonly string[];
} {
  // 期限切れのスタッフを候補から外す（P8-02 / §1.4 MUST）。
  // **engine は在留資格を知らない。** 純粋関数に法令の概念を持ち込まず、
  // 候補の絞り込みで表す（スキル外を外す P8-04 も同じ形になる予定）。
  const blocked = new Set(board.blockedMembershipIds);
  const assignable = board.staff.filter((person) => !blocked.has(person.membershipId));
  const plan = planAutoAssignment(board.tasks, assignable);
  return {
    pairs: plan.assignments,
    loads: plan.loads,
    unassignedTaskIds: plan.unassignedTaskIds,
  };
}

/** 適用の入力。**`propertyId` はサーバー側で解決した値を渡すこと。** */
export interface ApplyAssignmentsInput {
  propertyId: string;
  businessDate: string;
  /** `membershipId` が `null` なら担当を外す（未割当へ戻す）。 */
  pairs: readonly { taskId: string; membershipId: string | null }[];
  actorId: string;
  /** 作業中のタスクの引き継ぎを確認済みか（§4.2 の警告）。 */
  confirmActive?: boolean | undefined;
  ip?: string | undefined;
}

/** 適用の結果。 */
export interface ApplyAssignmentsResult {
  applied: number;
  /**
   * 作業中のため見送ったタスク（§4.2 の「警告を出す」）。
   * 画面はこれを示し、確認のうえ `confirmActive` を付けて送り直す。
   */
  activeTaskIds: readonly string[];
  /**
   * 期限切れのスタッフ宛てだったため見送ったタスク（P8-02）。
   * **確認を付けても通らない**（`activeTaskIds` と違い、送り直す口が無い）。
   * 解除は `ORG_ADMIN` が在留期限を更新したときだけ（§1.4 MUST）。
   */
  blockedTaskIds: readonly string[];
}

/**
 * 担当者を書き換える。
 *
 * ── クライアントの値をどこまで信じるか ──────────────────
 * `taskId` も `membershipId` も**その施設・その業務日のものだけ**を通す。
 * 一覧で突き合わせてから書くので、別施設のタスク ID や、担当外の
 * スタッフ ID を混ぜても黙って落ちる（`assertIdBelongsToTenant()` の
 * さらに内側の絞り込み / INV-32）。
 */
export async function applyAssignments(
  env: Env,
  ctx: TenantContext,
  input: ApplyAssignmentsInput,
): Promise<ApplyAssignmentsResult> {
  assertPermission(ctx, "task.manage", propertyTarget([input.propertyId]));

  const [rows, staff, blocked] = await Promise.all([
    listTasks(env, ctx, { propertyId: input.propertyId, businessDate: input.businessDate }),
    listPropertyStaff(env, ctx, input.propertyId),
    // **クライアントの盤面を信じない。** 期限切れの判定はここで引き直す
    // （プレビューの後に期限が切れた場合も、適用の時点の事実で止める）。
    listAssignmentBlockedMembershipIds(env, ctx, input.businessDate),
  ]);
  const taskById = new Map(rows.map((task) => [task.id, task]));
  const knownStaff = new Set(staff.map((person) => person.membershipId));

  const activeTaskIds: string[] = [];
  const blockedPairs: string[] = [];
  /** 担当者ごとにまとめる。1 件ずつ UPDATE すると往復が件数ぶん増える。 */
  const byAssignee = new Map<string, string[]>();
  const changes: { taskId: string; before: string | null; after: string | null }[] = [];

  for (const pair of input.pairs) {
    const task = taskById.get(pair.taskId);
    if (task === undefined) continue;
    if (task.status === "CANCELLED" || task.status === "COMPLETED") continue;
    if (pair.membershipId !== null && !knownStaff.has(pair.membershipId)) continue;
    // 期限切れのスタッフへ**新しく**配らない（P8-02 / §1.4 MUST）。
    // **担当を外す側（`null`）は通す** — 既存の割当を整理する操作まで
    // 止めると、期限切れの人からタスクを剥がせなくなる。
    if (pair.membershipId !== null && blocked.has(pair.membershipId)) {
      blockedPairs.push(pair.taskId);
      continue;
    }
    if (task.assigneeId === pair.membershipId) continue;

    const isActive = task.status !== "CREATED" && task.status !== "ASSIGNED";
    if (isActive && input.confirmActive !== true) {
      activeTaskIds.push(task.id);
      continue;
    }

    const key = pair.membershipId ?? "";
    const bucket = byAssignee.get(key);
    if (bucket === undefined) byAssignee.set(key, [task.id]);
    else bucket.push(task.id);
    changes.push({ taskId: task.id, before: task.assigneeId, after: pair.membershipId });
  }

  let applied = 0;
  for (const [membershipId, taskIds] of byAssignee) {
    applied += await assignTasks(env, ctx, taskIds, membershipId === "" ? null : membershipId, {
      includeActive: input.confirmActive === true,
    });
  }

  // §4.2「変更は AuditLog に記録する」。**タスク 1 件につき 1 行。**
  // まとめて 1 行にすると、あとから 1 件の担当変更を追えなくなる。
  for (const change of changes) {
    await recordAudit(env, ctx, {
      actorId: input.actorId,
      action: "task.assigned",
      targetType: "cleaningTask",
      targetId: change.taskId,
      propertyId: input.propertyId,
      before: { assigneeId: change.before },
      after: { assigneeId: change.after },
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
  }

  return { applied, activeTaskIds, blockedTaskIds: blockedPairs };
}
