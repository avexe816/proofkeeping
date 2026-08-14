/**
 * 業務上の入室記録の API（PK-SPEC-P4 §2.3・§4.1）。
 *
 * ```
 * GET  /api/v1/room-access-logs?propertyId=&from=&to=&roomId=
 * POST /api/v1/room-access-logs
 * ```
 *
 * task:  docs/tasks/P4-10.md
 * ルール: .claude/rules/security.md §3（保存してはいけないデータ）
 *
 * ── 登録すると差異が抑制される ──────────────────────────
 * §4.1。だから**書ける相手を絞る**（`roomAccess.write` は施設責任者以上 /
 * DECISIONS #115）。`CLEANER` / `INSPECTOR` / `VENDOR_ADMIN` は 404。
 *
 * ── 更新・削除の口が無い ────────────────────────────────
 * 抑制の根拠を後から書き換えられる形にしない
 * （`createRoomAccessLog()` の注記）。
 *
 * ── 宿泊者を書く欄が無い ────────────────────────────────
 * `actorName` は立ち入った担当者（従業員・業者）。security.md §3。
 */

import {
  ROOM_ACCESS_MAX_FUTURE_DAYS,
  ROOM_ACCESS_MAX_PAST_DAYS,
  roomAccessCreateRequestSchema,
  type RoomAccessCreateResponse,
  type RoomAccessError,
  type RoomAccessListResponse,
} from "@pk/contracts";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import {
  collectRoomAccessLogs,
  registerRoomAccess,
} from "../../../lib/reconciliation/roomAccess.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const roomAccessLogs = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): RoomAccessError {
  return { error: "INVALID_REQUEST" };
}

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 一覧（§2.3）。**施設を必須にする。** 組織全体の入室記録を並べる画面は無い。 */
roomAccessLogs.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "roomAccess.read", propertyTarget([propertyId]));

  const from = c.req.query("from");
  const to = c.req.query("to");
  if (
    (from !== undefined && !BUSINESS_DATE.test(from)) ||
    (to !== undefined && !BUSINESS_DATE.test(to))
  ) {
    return c.json(invalidRequest(), 400);
  }

  const body: RoomAccessListResponse = {
    data: await collectRoomAccessLogs(c.env, ctx, {
      propertyId,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(c.req.query("roomId") === undefined ? {} : { roomId: c.req.query("roomId") }),
    }),
  };
  return c.json(body);
});

/**
 * 登録（§2.3）。事前・事後のどちらでも同じ経路。
 *
 * **施設は客室から解決する**（INV-32）。リクエストの `propertyId` を
 * 権限判定に使わない。
 */
roomAccessLogs.post("/", async (c) => {
  const ctx = getTenant(c);
  const parsed = roomAccessCreateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  // **登録できる時刻に幅を持たせる**（`ROOM_ACCESS_MAX_*_DAYS` の注記）。
  // 事前登録を無制限に許すと、押し忘れた登録が抑制として効き続ける。
  const now = ctx.now.getTime();
  const entered = parsed.data.enteredAt;
  if (
    entered < now - ROOM_ACCESS_MAX_PAST_DAYS * DAY_MS ||
    entered > now + ROOM_ACCESS_MAX_FUTURE_DAYS * DAY_MS
  ) {
    return c.json(invalidRequest(), 400);
  }

  // 客室から施設を解決してから判定する。**存在しない客室は 404。**
  const created = await registerRoomAccess(c.env, ctx, {
    roomId: parsed.data.roomId,
    purpose: parsed.data.purpose,
    enteredAt: parsed.data.enteredAt,
    exitedAt: parsed.data.exitedAt,
    actorName: parsed.data.actorName,
    note: parsed.data.note,
    registeredById: getSession(c).membershipId,
    assertWritable: (propertyId) => {
      assertPermission(ctx, "roomAccess.write", propertyTarget([propertyId]));
    },
  });
  if (created === null) return c.notFound();

  const body: RoomAccessCreateResponse = { data: created };
  return c.json(body, 201);
});

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default roomAccessLogs;
