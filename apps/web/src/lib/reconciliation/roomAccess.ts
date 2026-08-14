/**
 * 業務上の入室記録の組み立て（PK-SPEC-P4 §2.3・§4.1）。
 *
 * task:  docs/tasks/P4-10.md
 * ルール: .claude/rules/architecture.md §7（業務日）
 *
 * ── 業務日はここで決める ────────────────────────────────
 * `enteredAt` と施設の日締め時刻から `businessDateOf()` で求める。
 * **クライアントに選ばせない**（`packages/contracts/src/roomAccess.ts` の注記）。
 * 抑制が効く日（§4.1）と入室した日がずれる経路を作らないため。
 *
 * ── 権限判定はここに無い ────────────────────────────────
 * 呼び出し側が `assertPermission(ctx, "roomAccess.write", ...)` を先に通す。
 * **登録できる相手は施設責任者以上**（DECISIONS #115）。
 */

import type { RoomAccessLogSummary, RoomAccessPurposeValue } from "@pk/contracts";
import {
  createRoomAccessLog,
  findPropertyById,
  findRoomById,
  listRoomAccessLogs,
  listRoomNumbersByIds,
  type Env,
  type TenantContext,
} from "@pk/db";

import { businessDateOf } from "../businessDate.js";

/** 一覧の絞り込み（期間・客室）。 */
export interface RoomAccessQuery {
  propertyId: string;
  from?: string | undefined;
  to?: string | undefined;
  roomId?: string | undefined;
}

/** 一覧（§2.3）。**部屋番号を添える**（ID だけでは現場と話せない）。 */
export async function collectRoomAccessLogs(
  env: Env,
  ctx: TenantContext,
  query: RoomAccessQuery,
): Promise<RoomAccessLogSummary[]> {
  const rows = await listRoomAccessLogs(env, ctx, {
    propertyId: query.propertyId,
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.roomId === undefined ? {} : { roomId: query.roomId }),
  });

  const roomNumbers = await listRoomNumbersByIds(
    env,
    ctx,
    rows.map((row) => row.roomId),
  );

  return rows.map((row) => ({
    id: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId,
    roomNumber: roomNumbers.get(row.roomId) ?? "",
    businessDate: row.businessDate,
    purpose: row.purpose,
    enteredAt: row.enteredAt.getTime(),
    exitedAt: row.exitedAt?.getTime() ?? null,
    actorName: row.actorName,
    note: row.note,
    registeredAt: row.registeredAt.getTime(),
  }));
}

/** `registerRoomAccess()` の入力。**業務日を受け取らない。** */
export interface RegisterRoomAccessInput {
  roomId: string;
  purpose: RoomAccessPurposeValue;
  enteredAt: number;
  exitedAt: number | null;
  actorName: string | null;
  note: string | null;
  registeredById: string;
  /**
   * 解決した施設に対する書き込み権限の判定。**呼び出し側が渡す。**
   *
   * リクエストの `propertyId` を権限判定に使わない（INV-32）ため、
   * 施設は客室から解決してからでないと判定できない。権限が無ければ
   * 投げること（`assertPermission()` がそのまま使える）。
   */
  assertWritable: (propertyId: string) => void;
}

/**
 * 登録（§2.3）。事前・事後のどちらでも同じ経路。
 *
 * @returns 登録した 1 件。客室が見つからなければ `null`（→ 404）。
 */
export async function registerRoomAccess(
  env: Env,
  ctx: TenantContext,
  input: RegisterRoomAccessInput,
): Promise<RoomAccessLogSummary | null> {
  const room = await findRoomById(env, ctx, input.roomId);
  if (room === undefined) return null;

  input.assertWritable(room.propertyId);

  const property = await findPropertyById(env, ctx, room.propertyId);
  if (property === undefined) return null;

  const enteredAt = new Date(input.enteredAt);
  const businessDate = businessDateOf(enteredAt, property.timezone, property.dayCutoffTime);

  const id = await createRoomAccessLog(env, ctx, {
    propertyId: room.propertyId,
    roomId: room.id,
    businessDate,
    purpose: input.purpose,
    enteredAt,
    exitedAt: input.exitedAt === null ? null : new Date(input.exitedAt),
    actorName: input.actorName,
    note: input.note,
    registeredById: input.registeredById,
  });

  return {
    id,
    propertyId: room.propertyId,
    roomId: room.id,
    roomNumber: room.roomNumber,
    businessDate,
    purpose: input.purpose,
    enteredAt: input.enteredAt,
    exitedAt: input.exitedAt,
    actorName: input.actorName,
    note: input.note,
    registeredAt: ctx.now.getTime(),
  };
}
