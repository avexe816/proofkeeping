/**
 * 客室ボードの読み出し（PK-SPEC-P1 §9.5 / §10.1 W-03）。
 *
 * task: docs/tasks/P1-15.md
 *
 * ── W-03 と M-10 で 1 つ ────────────────────────────────
 * PC とモバイルで**同じ盤面**を描く。並びと区分は `packages/engine` の
 * `buildRoomBoard()`、読み出しはここ、描くのは各画面。3 層に分けてあるので
 * 「PC だけ部屋の順が違う」が起きない。
 *
 * ── 引くのは 1 施設 × 1 業務日で 5 回まで ───────────────
 * 客室・階・タスク・写真枚数・スタッフ。**客室ごと・タスクごとに引かない**
 * （§13 の応答時間。100 室で 100 クエリになる）。
 *
 * ── 氏名の出し分けはここで閉じる ────────────────────────
 * INV-06。`canViewStaffName()` が偽のロールには `displayName` を
 * `null` で返す。**画面に生の氏名を渡さない。**
 */

import {
  countPhotosByTask,
  findPropertyById,
  listFloors,
  listPropertyStaff,
  listRooms,
  listTasks,
  NotFoundError,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  buildRoomBoard,
  countRoomsByGroup,
  type BoardSection,
  type RoomBoardGroup,
} from "@pk/engine";

import { assertPermission, can, propertyTarget } from "../auth/permission.js";
import { canViewStaffName } from "../ui/staffName.js";

/** 盤面に添える担当者。**氏名は伏せることがある**（INV-06）。 */
export interface BoardStaff {
  membershipId: string;
  staffNumber: string;
  displayName: string | null;
}

/** 画面が受け取る盤面。 */
export interface RoomBoardView {
  propertyId: string;
  propertyName: string;
  businessDate: string;
  counts: Record<RoomBoardGroup, number>;
  sections: readonly BoardSection[];
  staff: readonly BoardStaff[];
  /** 手動上書き（§11.2）に到達してよいか。**表示の出し分けであって権限ではない。** */
  canOverride: boolean;
}

/**
 * 盤面を読む。
 *
 * @param now 現在時刻。経過時間の計算に使う（engine へ渡す）。
 * @throws {NotFoundError} 施設が無い・担当外（404 / INV-31）。
 */
export async function loadRoomBoard(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
  now: Date,
): Promise<RoomBoardView> {
  const property = await findPropertyById(env, ctx, propertyId);
  if (property === undefined) throw new NotFoundError();
  assertPermission(ctx, "property.read", propertyTarget([property.id]));

  const [rooms, floors, tasks, staff] = await Promise.all([
    listRooms(env, ctx, { propertyId, isActive: true }),
    listFloors(env, ctx, propertyId),
    listTasks(env, ctx, { propertyId, businessDate }),
    listPropertyStaff(env, ctx, propertyId),
  ]);

  const photoCounts = await countPhotosByTask(
    env,
    ctx,
    tasks.map((task) => task.id),
  );
  const floorById = new Map(floors.map((row) => [row.id, row]));
  const showName = canViewStaffName(ctx.role);

  const sections = buildRoomBoard(
    rooms.map((room) => {
      const floor = room.floorId === null ? undefined : floorById.get(room.floorId);
      return {
        roomId: room.id,
        roomNumber: room.roomNumber,
        floorName: floor?.name ?? null,
        floorOrder: floor?.sortOrder ?? null,
        isSellable: room.isSellable,
        housekeepingStatus: room.housekeepingStatus,
      };
    }),
    tasks.map((task) => ({
      taskId: task.id,
      roomId: task.roomId,
      status: task.status,
      assigneeId: task.assigneeId,
      startedAt: task.startedAt?.getTime() ?? null,
      actualMinutes: task.actualMinutes,
      photoCount: photoCounts.get(task.id) ?? 0,
    })),
    now.getTime(),
  );

  return {
    propertyId: property.id,
    propertyName: property.name,
    businessDate,
    // 件数は**売れる客室だけ**（清掃専用の場所を客室数に含めない / §24.3）。
    counts: countRoomsByGroup(
      rooms.filter((room) => room.isSellable).map((room) => ({ housekeepingStatus: room.housekeepingStatus })),
    ),
    sections,
    staff: staff.map((person) => ({
      membershipId: person.membershipId,
      staffNumber: person.staffNumber,
      displayName: showName ? person.displayName : null,
    })),
    // **表示の出し分けであって権限制御ではない**（security.md §1）。
    // 実際の判定は `overrideRoomStatus()` が毎回サーバー側で行う。
    canOverride: can(ctx, "room.statusOverride", propertyTarget([property.id])),
  };
}
