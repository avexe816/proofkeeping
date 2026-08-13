/**
 * 客室タイプの API（W-25 / PK-SPEC-P0 §24.3・§24.5）。
 *
 * ```
 * GET   /api/v1/room-types?propertyId=
 * POST  /api/v1/room-types
 * PATCH /api/v1/room-types/:roomTypeId
 * ```
 *
 * task: docs/tasks/P1-24.md
 *
 * ── 新しい権限 action を足していない ────────────────────
 * 客室タイプは施設マスタの一部で、`property.read` / `property.write` で足りる。
 * security.md §1 に「客室タイプ」を独立の権限として扱う根拠が無い。
 *
 * ── 物理削除の口が無い ──────────────────────────────────
 * CLAUDE.md §4。無効化は `PATCH { isActive: false }`。**`DELETE` を
 * 足さないこと。** 標準時間（`standardTime`）とチェックリストの
 * 第 3 階層がこの ID を参照しており、行が消えると過去の設定が宙に浮く。
 *
 * ── Idempotency-Key ─────────────────────────────────────
 * ヘッダは受けるが、**鍵の記録という別の状態を作らない。**
 * `POST` は `uq_room_type_property_code` により 2 回目が
 * `onConflictDoNothing()` で弾かれ、既存の 1 件を返す。`PATCH` は
 * 渡された項目をその値にするだけで、何度送っても同じ状態になる。
 * 採番も課金も伴わないため、`routes/api/v1/session.ts` と同じ判断
 * （docs/DECISIONS.md #055）。
 */

import {
  roomTypeCreateSchema,
  roomTypeUpdateSchema,
  type RoomTypeListResponse,
  type RoomTypeSummary,
} from "@pk/contracts";
import {
  countRoomsByRoomType,
  createRoomType,
  findRoomTypeById,
  listRoomTypes,
  recordAudit,
  updateRoomType,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const roomTypes = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 一覧。**無効化済みも返す。**
 *
 * 運用の画面（W-05 / W-16 / W-17）はリポジトリを直接呼んでおり
 * （docs/DECISIONS.md #049）、既定の「有効なものだけ」が効く。
 * この口を叩くのは設定を編むためなので、無効化済みが見えないと
 * 打ち間違えた 1 件を取り消せない。
 */
roomTypes.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "property.read", propertyTarget([propertyId]));

  const [rows, roomCounts] = await Promise.all([
    listRoomTypes(c.env, ctx, propertyId, {}),
    countRoomsByRoomType(c.env, ctx, propertyId),
  ]);

  const body: RoomTypeListResponse = {
    propertyId,
    data: rows.map((row) => toSummary(row, roomCounts.get(row.id) ?? 0)),
  };
  return c.json(body);
});

/**
 * 作成。**コードの重複はエラーにしない。**
 *
 * 既存とぶつかったら 409 を返す。`createRooms()` の「見送る」と違い、
 * こちらは 1 件ずつの操作なので、黙って無視すると「作ったつもりで
 * 作られていない」状態になる。**ただし本文は理由だけを述べ、
 * 既存の行の中身は返さない。**
 */
roomTypes.post("/", async (c) => {
  const parsed = roomTypeCreateSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "property.write", propertyTarget([parsed.data.propertyId]));

  const result = await createRoomType(c.env, ctx, parsed.data);
  if (!result.created) return c.json({ error: "DUPLICATE_CODE" as const }, 409);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    // security.md §6「施設・客室マスタの作成」。`AUDIT_ACTIONS` は閉じた
    // レジストリで、客室タイプ専用の行を足す根拠が §6 の列挙に無い。
    action: "property.created",
    targetType: "roomType",
    targetId: result.id,
    propertyId: parsed.data.propertyId,
    after: {
      code: parsed.data.code,
      name: parsed.data.name,
      bedCount: parsed.data.bedCount ?? null,
      capacity: parsed.data.capacity ?? null,
    },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ roomTypeId: result.id }, 201);
});

/**
 * 更新・無効化。
 *
 * **無効化の前に客室数を提示するのは画面の責務**（§24.5 / `rooms.tsx` の
 * `confirmDeactivate` が先例）。API は 1 回で無効化する。確認の段を
 * ここへ持ち込むと、同じ判断が 2 か所に分かれる。
 */
roomTypes.patch("/:roomTypeId", async (c) => {
  const parsed = roomTypeUpdateSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const roomTypeId = c.req.param("roomTypeId");

  // **施設の権限を見る前に、その客室タイプの施設を確かめる。**
  // 越境 ID は `findRoomTypeById()` が DB へ行く前に 404 にする。
  const before = await findRoomTypeById(c.env, ctx, roomTypeId);
  if (before === undefined) return c.json({ error: "RESOURCE_NOT_FOUND" as const }, 404);

  assertPermission(ctx, "property.write", propertyTarget([before.propertyId]));

  await updateRoomType(c.env, ctx, roomTypeId, parsed.data);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    // 無効化も `property.updated`。§6 の「施設・客室マスタの更新・無効化」は
    // 同じ行にあり、客室（`room.deactivated`）のように別の action を持つ
    // 根拠が客室タイプには無い。`after.isActive` で区別できる。
    action: "property.updated",
    targetType: "roomType",
    targetId: roomTypeId,
    propertyId: before.propertyId,
    before: {
      name: before.name,
      bedCount: before.bedCount,
      capacity: before.capacity,
      sortOrder: before.sortOrder,
      isActive: before.isActive,
    },
    after: parsed.data,
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ roomTypeId });
});

/** 一覧の 1 件。**`organizationId` を落とす**（組織 ID を応答に出さない）。 */
function toSummary(
  row: {
    id: string;
    propertyId: string;
    code: string;
    name: string;
    bedCount: number | null;
    capacity: number | null;
    sortOrder: number;
    isActive: boolean;
  },
  roomCount: number,
): RoomTypeSummary {
  return {
    roomTypeId: row.id,
    propertyId: row.propertyId,
    code: row.code,
    name: row.name,
    bedCount: row.bedCount,
    capacity: row.capacity,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    roomCount,
  };
}

function ipOf(ip: string | undefined): { ip?: string } {
  return ip === undefined ? {} : { ip };
}

export default roomTypes;
