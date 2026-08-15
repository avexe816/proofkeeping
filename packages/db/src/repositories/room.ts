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

import { count, eq, inArray } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { chunkIdsForInArray } from "../limits.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  floor,
  room,
  type HousekeepingStatus,
  type RoomSaleStatus,
} from "../schema/property.js";

import { withTenantScope } from "./base.js";

/**
 * `setHousekeepingStatus()` が客室 ID 以外に使うバインド変数の見込み。
 *
 * `SET` 句（`housekeepingStatus` / `updatedAt`）と組織条件・施設スコープ
 * （15 件まで）を見込む。**多めに取る**（境界だけが落ちる形を避ける）。
 */
const SET_HOUSEKEEPING_RESERVED_PARAMS = 20;

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

/**
 * 客室 ID から部屋番号を引く（差異一覧 W-06 / P4-06）。
 *
 * **一覧のために組織の全客室を読まない。** 差異は最大 200 件（=最大 200 室）で、
 * 施設をまたぐ一覧では `listRooms()` が数千行を返しうる。
 * 越境 ID は `withTenantScope()` の条件に一致せず、単に落ちる
 * （まとめて引くので `assertIdBelongsToTenant()` は掛けない）。
 */
export async function listRoomNumbersByIds(
  env: Env,
  ctx: TenantContext,
  roomIds: readonly string[],
): Promise<Map<string, string>> {
  if (roomIds.length === 0) return new Map();
  const db = await getTenantDb(env, ctx);

  const numbers = new Map<string, string>();
  // **D1 は 1 文 100 変数まで**（`limits.ts`）。200 件は必ず割る。
  for (const chunk of chunkIdsForInArray([...new Set(roomIds)])) {
    const rows = await db
      .select({ id: room.id, roomNumber: room.roomNumber })
      .from(room)
      .where(withTenantScope(room, ctx, room.propertyId, inArray(room.id, [...chunk])));
    for (const row of rows) numbers.set(row.id, row.roomNumber);
  }
  return numbers;
}

/**
 * 施設ごとの客室数。**`isSellable = true` の有効な客室だけを数える。**
 *
 * task: docs/tasks/P0-21.md / docs/tasks/P0-22.md
 * 仕様: docs/PK-SPEC-P0.md §24.3（清掃専用の場所を客室数に含めない）
 *
 * ── これは「タスクテーブルへの直接集計」ではない ────────
 * §26 が禁じているのは**稼働状況のサマリー**を rollup 以外から取ることで、
 * 客室数は客室マスタにしか存在しない。`dailyPropertyRollup` に室数の列は無い。
 *
 * 組織内の GROUP BY なので、テナント横断の集計にはあたらない
 * （architecture.md §3 が禁じるのは組織をまたぐ集計）。
 */
/**
 * 組織の有効な客室の総数（P7-03 / PK-SPEC-P7 §2.5 の「客室 150 室まで」）。
 *
 * **販売可能かどうかを見ない。** §2.5 の上限は「客室」であって
 * 「販売できる客室」ではない。清掃専用の場所（PANTRY）も 1 室と数える。
 * 無効化した行は数えない（枠を戻せないと、打ち間違えた 1 室で詰む）。
 *
 * 組織内の集計なので、テナント横断にはあたらない（architecture.md §3）。
 */
export async function countRooms(env: Env, ctx: TenantContext): Promise<number> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ count: count() })
    .from(room)
    .where(withTenantScope(room, ctx, room.propertyId, eq(room.isActive, true)));
  return rows[0]?.count ?? 0;
}

export async function countSellableRoomsByProperty(
  env: Env,
  ctx: TenantContext,
): Promise<Map<string, number>> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ propertyId: room.propertyId, count: count() })
    .from(room)
    .where(
      withTenantScope(
        room,
        ctx,
        room.propertyId,
        eq(room.isSellable, true),
        eq(room.isActive, true),
      ),
    )
    .groupBy(room.propertyId);
  return new Map(rows.map((row) => [row.propertyId, row.count]));
}

/**
 * 施設の中で、客室タイプごとに何室が割り当てられているか。
 *
 * task: docs/tasks/P1-24.md
 * 仕様: docs/PK-SPEC-P0.md §24.5（無効化の前に影響件数を提示する）
 *
 * ── 有効な客室だけを数える ──────────────────────────────
 * 無効化済みの客室を数に入れると、「3 室あります」と言われて客室一覧を
 * 見に行っても 1 室しか見つからない、という食い違いが起きる。
 * **`isSellable` では絞らない。** 清掃専用の場所にも客室タイプは付く
 * （§24.2 の `PANTRY`）。無効化の影響を受ける点では客室と同じ。
 *
 * 客室タイプが未設定（`roomTypeId IS NULL`）の客室は返さない。
 * `GROUP BY` で NULL の行が 1 つのキーにまとまるが、呼び出し側が
 * 引くのは客室タイプの ID なので、そのキーには到達しない。
 */
export async function countRoomsByRoomType(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
): Promise<Map<string, number>> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ roomTypeId: room.roomTypeId, count: count() })
    .from(room)
    .where(
      withTenantScope(
        room,
        ctx,
        room.propertyId,
        eq(room.propertyId, propertyId),
        eq(room.isActive, true),
      ),
    )
    .groupBy(room.roomTypeId);
  return new Map(
    rows
      .filter((row): row is { roomTypeId: string; count: number } => row.roomTypeId !== null)
      .map((row) => [row.roomTypeId, row.count]),
  );
}

/**
 * 階の一覧（客室ボードの見出し / PK-SPEC-P1 §9.5）。
 *
 * task: docs/tasks/P1-15.md
 *
 * **客室ごとに引かない。** 施設 1 件ぶんを 1 回で引いて突き合わせる
 * （§13 の応答時間。100 室の盤面で 100 クエリになる）。
 */
export async function listFloors(env: Env, ctx: TenantContext, propertyId: string) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(floor)
    .where(withTenantScope(floor, ctx, floor.propertyId, eq(floor.propertyId, propertyId)))
    .orderBy(floor.sortOrder, floor.name);
}

/**
 * 客室の清掃ステータスを書き換える（PK-SPEC-P1 §11）。
 *
 * task: docs/tasks/P1-16.md
 *
 * ── 監査ログはここで書かない ────────────────────────────
 * 自動同期（§11.1）は記録しない。タスクの状態変化に従属した結果で、
 * 元の操作（`task.completed` 等）が既に `AuditLog` に残っている。
 * **手動上書き（§11.2）は必ず `room.statusOverridden` を残すこと。**
 * 呼び出し側（`routes/api/v1/rooms.ts`）の責務（P0-07 の方針）。
 *
 * @returns 書き換えた行数。0 は「その客室が無い（または担当外）」。
 */
export async function setHousekeepingStatus(
  env: Env,
  ctx: TenantContext,
  roomIds: readonly string[],
  status: HousekeepingStatus,
): Promise<number> {
  for (const roomId of roomIds) assertIdBelongsToTenant(roomId, ctx);
  if (roomIds.length === 0) return 0;

  const db = await getTenantDb(env, ctx);

  // **D1 は 1 文 100 変数まで**（`limits.ts`）。タスクの自動生成は
  // 施設の全客室ぶんの ID を渡してくる（`lib/task/generate.ts`）。
  // `SET` 句が 1 変数（`updatedAt`）を使うぶんも `reserved` に含める。
  let changed = 0;
  for (const chunk of chunkIdsForInArray(roomIds, SET_HOUSEKEEPING_RESERVED_PARAMS)) {
    const result = await db
      .update(room)
      .set({ housekeepingStatus: status, updatedAt: ctx.now })
      .where(withTenantScope(room, ctx, room.propertyId, inArray(room.id, [...chunk])));
    changed += result.meta.changes;
  }
  return changed;
}

/**
 * 客室の販売可否を書き換える（PK-SPEC-P2 §8.2）。
 *
 * task: docs/tasks/P2-12.md
 *
 * ── `setHousekeepingStatus()` と分けてある ──────────────
 * 2 つは別の軸（`schema/property.ts` の `ROOM_SALE_STATUSES` の注記）。
 * §8.2 MUST は `CRITICAL` の不具合で両方を立てると定めており、
 * 呼び出し側が 2 回呼ぶ。**1 つの関数にまとめないこと。** まとめると
 * 「清掃が終わったので販売可へ戻す」が書けてしまい、§8.3 の
 * 「不具合を閉じても客室状態は自動復旧しない」が崩れる。
 *
 * ── 監査ログはここで書かない ────────────────────────────
 * `setHousekeepingStatus()` と同じ方針。`OUT_OF_ORDER` へ倒すのは
 * 不具合報告に従属した結果で、元の操作（`issue.reported`）が残る。
 * **`AVAILABLE` へ戻す操作は必ず `room.statusOverridden` を残すこと**
 * （理由必須 / §8.3 の「明示操作」）。
 *
 * @returns 書き換えた行数。0 は「その客室が無い（または担当外）」。
 */
export async function setRoomSaleStatus(
  env: Env,
  ctx: TenantContext,
  roomIds: readonly string[],
  status: RoomSaleStatus,
): Promise<number> {
  for (const roomId of roomIds) assertIdBelongsToTenant(roomId, ctx);
  if (roomIds.length === 0) return 0;

  const db = await getTenantDb(env, ctx);

  // **D1 は 1 文 100 変数まで**（`limits.ts`）。`setHousekeepingStatus()` と
  // 同じ分割を通す（`SET` 句の `updatedAt` ぶんを `reserved` に含める）。
  let changed = 0;
  for (const chunk of chunkIdsForInArray(roomIds, SET_HOUSEKEEPING_RESERVED_PARAMS)) {
    const result = await db
      .update(room)
      .set({ saleStatus: status, updatedAt: ctx.now })
      .where(withTenantScope(room, ctx, room.propertyId, inArray(room.id, [...chunk])));
    changed += result.meta.changes;
  }
  return changed;
}

/** `createRooms()` の 1 行ぶん。ID・組織・時刻は受け取らない。 */
export interface CreateRoomInput {
  propertyId: string;
  roomNumber: string;
  roomTypeId?: string | undefined;
  buildingId?: string | undefined;
  floorId?: string | undefined;
  /** 既定 true。false は清掃専用の場所（§24.3）。 */
  isSellable?: boolean | undefined;
  /** 登録経路。範囲一括は `MANUAL`、CSV 取込は `CSV`。 */
  sourceType?: "MANUAL" | "CSV" | undefined;
  note?: string | undefined;
  sortOrder?: number | undefined;
}

/** `createRooms()` の結果。**既存はエラーにせず見送る**（§24.2 MUST）。 */
export interface CreateRoomsResult {
  created: number;
  skipped: number;
  createdIds: readonly string[];
}

/**
 * 客室をまとめて作る。
 *
 * **既に在る部屋番号は見送る。** 100 室の一括登録で 1 室ぶつかっただけで
 * 全部やり直しになると、現場で使えない（§24.2「エラーにしない」）。
 * 見送った件数は呼び出し側が画面に出す。
 *
 * 冪等: 同じ入力で 2 回呼んでも 2 回目は全件 `skipped`
 * （`uq_room_property_number` と `onConflictDoNothing()`）。
 */
export async function createRooms(
  env: Env,
  ctx: TenantContext,
  inputs: readonly CreateRoomInput[],
): Promise<CreateRoomsResult> {
  const db = await getTenantDb(env, ctx);

  const createdIds: string[] = [];
  let created = 0;
  for (const input of inputs) {
    const id = generateId(ctx.orgShortId, "room");
    const result = await db
      .insert(room)
      .values({
        id,
        organizationId: ctx.organizationId,
        propertyId: input.propertyId,
        roomNumber: input.roomNumber,
        roomTypeId: input.roomTypeId ?? null,
        buildingId: input.buildingId ?? null,
        floorId: input.floorId ?? null,
        isSellable: input.isSellable ?? true,
        sourceType: input.sourceType ?? "MANUAL",
        note: input.note ?? null,
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoNothing();

    // D1 は影響行数を meta.changes で返す。0 なら既存とぶつかって見送られた。
    if (result.meta.changes > 0) {
      created += 1;
      createdIds.push(id);
    }
  }

  return { created, skipped: inputs.length - created, createdIds };
}

/** `updateRoom()` の入力。**`isSellable` と `sourceType` は変えない。** */
export interface UpdateRoomInput {
  roomNumber?: string | undefined;
  roomTypeId?: string | null | undefined;
  floorId?: string | null | undefined;
  note?: string | null | undefined;
  /** 無効化。**`true` へ戻す経路も残す**（誤操作の取り消し）。 */
  isActive?: boolean | undefined;
}

/**
 * 客室を更新する。**物理削除の関数は無い**（§26 / PK-SPEC-P0 §26）。
 *
 * 部屋番号の変更は許可する。**旧番号を `AuditLog` に残すのは呼び出し側**
 * （§24.5）。この層は監査ログを書かない（P0-07 の方針）。
 */
export async function updateRoom(
  env: Env,
  ctx: TenantContext,
  roomId: string,
  input: UpdateRoomInput,
): Promise<void> {
  assertIdBelongsToTenant(roomId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(room)
    .set({
      ...(input.roomNumber === undefined ? {} : { roomNumber: input.roomNumber }),
      ...(input.roomTypeId === undefined ? {} : { roomTypeId: input.roomTypeId }),
      ...(input.floorId === undefined ? {} : { floorId: input.floorId }),
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedAt: ctx.now,
    })
    .where(withTenantScope(room, ctx, room.propertyId, eq(room.id, roomId)));
}
