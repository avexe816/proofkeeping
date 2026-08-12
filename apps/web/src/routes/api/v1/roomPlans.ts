/**
 * 当日の客室状況の API（W-05 / PK-SPEC-P1 §3.4・§10.3）。
 *
 * ```
 * GET  /api/v1/room-plans?propertyId=&businessDate=
 * PUT  /api/v1/room-plans                 画面での一括入力
 * POST /api/v1/room-plans/import          CSV 取込
 * POST /api/v1/room-plans/all-checkout    全室アウト清掃として生成
 * ```
 *
 * task: docs/tasks/P1-04.md
 *
 * ── 「全室アウト清掃として生成」は必ず残す ──────────────
 * §3.4 の MUST。**データ入力を諦めても運用できる逃げ道。**
 * 導入初日から完璧な入力を求めると、現場が紙に戻る。
 */

import {
  roomPlanAllCheckoutRequestSchema,
  roomPlanImportRequestSchema,
  roomPlanUpsertRequestSchema,
  type RoomPlanUpsertResponse,
  type TaskError,
} from "@pk/contracts";
import { listRoomPlans, listRooms, upsertRoomPlans, type RoomPlanInput } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { parsePlanCsv } from "../../../lib/plan/csv.js";
import { getTenant, type AppEnv } from "../../../middleware/index.js";

const roomPlans = new Hono<AppEnv>();

function invalidRequest(): TaskError {
  return { error: "INVALID_REQUEST" };
}

/** 入力状況の取得（W-05 の一覧）。 */
roomPlans.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const businessDate = c.req.query("businessDate");
  if (propertyId === undefined || businessDate === undefined) {
    return c.json(invalidRequest(), 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "roomPlan.read", propertyTarget([propertyId]));

  const rows = await listRoomPlans(c.env, ctx, propertyId, businessDate);
  return c.json({
    businessDate,
    data: rows.map((row) => ({
      roomId: row.roomId,
      hasCheckout: row.hasCheckout,
      hasCheckin: row.hasCheckin,
      isStayover: row.isStayover,
      guestCount: row.guestCount,
      declineClean: row.declineClean,
      source: row.source,
    })),
  });
});

/** 画面での一括入力（§3.4 の手段 2）。 */
roomPlans.put("/", async (c) => {
  const body = roomPlanUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "roomPlan.write", propertyTarget([body.data.propertyId]));

  // **客室がその施設のものであることをサーバー側で確かめる。**
  // クライアントが送った `roomId` を信用しない（INV-32 と同じ理由）。
  const rooms = await listRooms(c.env, ctx, {
    propertyId: body.data.propertyId,
    isActive: true,
  });
  const known = new Set(rooms.map((room) => room.id));
  const entries = body.data.entries.filter((entry) => known.has(entry.roomId));

  const applied = await upsertRoomPlans(
    c.env,
    ctx,
    body.data.propertyId,
    body.data.businessDate,
    entries,
    "MANUAL",
  );

  const response: RoomPlanUpsertResponse = {
    businessDate: body.data.businessDate,
    applied,
    unknownRoomNumbers: [],
    skippedLines: [],
  };
  return c.json(response);
});

/**
 * CSV 取込（§3.4 の手段 1）。
 *
 * **読めなかった行を黙って捨てない。** 何行が取り込めなかったかと、
 * 客室マスタに無い部屋番号を返す。画面が事実として示す。
 */
roomPlans.post("/import", async (c) => {
  const body = roomPlanImportRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "roomPlan.write", propertyTarget([body.data.propertyId]));

  const parsed = parsePlanCsv(body.data.csv, body.data.businessDate);
  const rooms = await listRooms(c.env, ctx, {
    propertyId: body.data.propertyId,
    isActive: true,
  });
  const roomByNumber = new Map(rooms.map((room) => [room.roomNumber, room.id]));

  const unknownRoomNumbers: string[] = [];
  const entries: RoomPlanInput[] = [];
  for (const row of parsed.rows) {
    const roomId = roomByNumber.get(row.roomNumber);
    if (roomId === undefined) {
      unknownRoomNumbers.push(row.roomNumber);
      continue;
    }
    entries.push({
      roomId,
      hasCheckout: row.hasCheckout,
      hasCheckin: row.hasCheckin,
      isStayover: row.isStayover,
      guestCount: row.guestCount,
      declineClean: row.declineClean,
    });
  }

  const applied = await upsertRoomPlans(
    c.env,
    ctx,
    body.data.propertyId,
    body.data.businessDate,
    entries,
    "CSV",
  );

  const response: RoomPlanUpsertResponse = {
    businessDate: body.data.businessDate,
    applied,
    unknownRoomNumbers,
    skippedLines: parsed.skippedLines,
  };
  return c.json(response);
});

/**
 * 全室アウト清掃として生成（§3.4 の手段 3 / **MUST**）。
 *
 * 有効な売れる客室すべてに `hasCheckout = true` を入れる。**清掃専用の
 * 場所（`isSellable = false`）は含めない**（パントリーにアウト清掃は立たない）。
 *
 * 既に入力済みの行も上書きする。**「入力を諦めた」という操作なので、
 * 部分的に残った入力の方を正としない。** 取り消したい客室は現場で
 * タスクを取消す（§3.4 の「現場で不要分を取消」）。
 */
roomPlans.post("/all-checkout", async (c) => {
  const body = roomPlanAllCheckoutRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "roomPlan.write", propertyTarget([body.data.propertyId]));

  const rooms = await listRooms(c.env, ctx, {
    propertyId: body.data.propertyId,
    isActive: true,
    isSellable: true,
  });

  const applied = await upsertRoomPlans(
    c.env,
    ctx,
    body.data.propertyId,
    body.data.businessDate,
    rooms.map((room) => ({
      roomId: room.id,
      hasCheckout: true,
      hasCheckin: false,
      isStayover: false,
      guestCount: 0,
      declineClean: false,
    })),
    "MANUAL",
  );

  const response: RoomPlanUpsertResponse = {
    businessDate: body.data.businessDate,
    applied,
    unknownRoomNumbers: [],
    skippedLines: [],
  };
  return c.json(response);
});

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default roomPlans;
