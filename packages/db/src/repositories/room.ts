/**
 * 客室のリポジトリ。
 *
 * task: docs/tasks/P0-07.md
 * 仕様: docs/PK-SPEC-P0.md §24（客室マスタの 2 方式）
 *
 * ── isSellable ──────────────────────────────────────────
 * `false` は清掃専用の場所（パントリー・備品庫・大浴場）。客室数の集計に
 * 含めず、稼働照合（P4）の対象外（同 §24.3）。既定で除外はしない。
 * **画面が何を出すかは呼び出し側が `filter` で決める。**
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { room } from "../schema/property.js";

import { withTenantScope } from "./base.js";

/** `listRooms()` の絞り込み。未指定の項目は条件に加えない。 */
export interface RoomFilter {
  /**
   * 施設で絞る。**これは施設スコープの代わりにならない。**
   * 担当外の施設 ID を渡しても `withTenantScope()` の条件と AND されるため 0 件になる。
   */
  propertyId?: string | undefined;
  /** 清掃専用の場所を除くなら `true`。 */
  isSellable?: boolean | undefined;
  /** 無効化済みを除くなら `true`。 */
  isActive?: boolean | undefined;
}

/** 客室一覧。施設スコープロールには担当施設の客室だけが返る。 */
export async function listRooms(env: Env, ctx: TenantContext, filter: RoomFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(room)
    .where(
      withTenantScope(
        room,
        ctx,
        room.propertyId,
        filter.propertyId === undefined ? undefined : eq(room.propertyId, filter.propertyId),
        filter.isSellable === undefined ? undefined : eq(room.isSellable, filter.isSellable),
        filter.isActive === undefined ? undefined : eq(room.isActive, filter.isActive),
      ),
    );
}

/** 客室 1 件。越境 ID は DB へ行く前に `NotFoundError`（→ 404）。 */
export async function findRoomById(env: Env, ctx: TenantContext, roomId: string) {
  assertIdBelongsToTenant(roomId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(room)
    .where(withTenantScope(room, ctx, room.propertyId, eq(room.id, roomId)))
    .limit(1);
  return rows[0];
}
