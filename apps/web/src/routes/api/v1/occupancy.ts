/**
 * 稼働記録の API（PK-SPEC-P4 §8）。
 *
 * ```
 * GET  /api/v1/occupancy?propertyId=&businessDate=&source=
 * POST /api/v1/occupancy/snapshots     手入力での登録（source = MANUAL）
 * POST /api/v1/occupancy/import/csv    CSV 取込（§8.1）
 * ```
 *
 * task: docs/tasks/P4-02.md
 *
 * ── 削除の口が無い ──────────────────────────────────────
 * `DELETE` を作らない。稼働記録は差異の根拠で、消えると照合の説明が
 * つかなくなる。誤った取込は**同じ取込元で入れ直す**（上書きされる）。
 *
 * ── 取込元を名乗らせない ────────────────────────────────
 * `source` は口が決める。`/snapshots` は `MANUAL`、`/import/csv` は
 * `CSV_IMPORT`。**`PMS_API` を API 越しに名乗る経路を作らない**
 * （連携が入れた記録と人が入れた記録の区別が付かなくなる）。
 *
 * ── 再取込は上書きし、差分を残す ────────────────────────
 * §8.1 MUST。件数と変わった項目を `recordAudit()` に載せる
 * （`occupancy.imported`）。**内容が同じ再取込では監査ログを書かない。**
 * 3 回取込むたびに監査ログが 3 行増えると、本当に上書きが起きた回を
 * 探せなくなる。
 */

import {
  occupancyImportRequestSchema,
  occupancySnapshotUpsertRequestSchema,
  type OccupancyError,
  type OccupancyImportResponse,
  type OccupancyListResponse,
  type OccupancySnapshot,
} from "@pk/contracts";
import {
  OCCUPANCY_SOURCES,
  listOccupancySnapshots,
  listRooms,
  recordAudit,
  upsertOccupancySnapshots,
  type OccupancySnapshotInput,
  type OccupancySource,
  type TenantContext,
  type UpsertOccupancyResult,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { parseOccupancyCsv } from "../../../lib/occupancy/csv.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const occupancy = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): OccupancyError {
  return { error: "INVALID_REQUEST" };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 時刻は epoch ミリ秒で返す（契約側が `number`）。 */
function toMillis(value: Date | number | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : value;
}

function toSnapshot(row: Awaited<ReturnType<typeof listOccupancySnapshots>>[number]): OccupancySnapshot {
  return {
    id: row.id,
    propertyId: row.propertyId,
    roomId: row.roomId,
    businessDate: row.businessDate,
    source: row.source,
    isOccupied: row.isOccupied,
    guestCount: row.guestCount,
    adultCount: row.adultCount,
    childCount: row.childCount,
    reservationRef: row.reservationRef,
    channelCode: row.channelCode,
    checkInAt: toMillis(row.checkInAt),
    checkOutAt: toMillis(row.checkOutAt),
    isStayover: row.isStayover,
    nightsTotal: row.nightsTotal,
    nightIndex: row.nightIndex,
    ratePlanCode: row.ratePlanCode,
    isComplimentary: row.isComplimentary,
    isHouseUse: row.isHouseUse,
    importedAt: toMillis(row.importedAt) ?? 0,
  };
}

/** `source` の問い合わせ値。**未知の値は 400。** 黙って全件にしない。 */
function parseSource(raw: string | undefined): OccupancySource | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  return (OCCUPANCY_SOURCES as readonly string[]).includes(raw)
    ? (raw as OccupancySource)
    : null;
}

/**
 * 上書きが起きたときだけ監査ログを書く。
 *
 * `changesTruncated` が真なら内訳は途中までだが、件数は必ず残る
 * （`MAX_AUDIT_CHANGES` / `repositories/occupancy.ts`）。
 */
async function recordImportAudit(
  env: AppEnv["Bindings"],
  ctx: TenantContext,
  actorId: string,
  propertyId: string,
  businessDate: string,
  source: OccupancySource,
  result: UpsertOccupancyResult,
): Promise<void> {
  if (result.inserted === 0 && result.updated === 0) return;

  await recordAudit(env, ctx, {
    actorId,
    action: "occupancy.imported",
    targetType: "occupancySnapshot",
    targetId: propertyId,
    propertyId,
    after: {
      businessDate,
      source,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
      changes: result.changes,
      changesTruncated: result.changesTruncated,
    },
  });
}

/** 一覧（§8）。**`rawPayload` は返らない**（リポジトリが列を選んでいる）。 */
occupancy.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const businessDate = c.req.query("businessDate");
  if (propertyId === undefined || businessDate === undefined) {
    return c.json(invalidRequest(), 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return c.json(invalidRequest(), 400);

  const source = parseSource(c.req.query("source"));
  if (source === null) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "occupancy.read", propertyTarget([propertyId]));

  const rows = await listOccupancySnapshots(c.env, ctx, {
    propertyId,
    businessDate,
    source,
  });

  const response: OccupancyListResponse = {
    businessDate,
    data: rows.map(toSnapshot),
  };
  return c.json(response);
});

/**
 * 手入力での登録（§8）。**`source` は `MANUAL` 固定。**
 *
 * PMS も CSV も無い施設が、当日の稼働を手で入れる経路。ここが無いと
 * A 系統が空のままで、R001 が動かない（§1.2 の「B のみ」に落ちる）。
 */
occupancy.post("/snapshots", async (c) => {
  const body = occupancySnapshotUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "occupancy.write", propertyTarget([body.data.propertyId]));

  const inputs: OccupancySnapshotInput[] = body.data.entries.map((entry) => ({
    roomId: entry.roomId,
    isOccupied: entry.isOccupied,
    // 空室に人数を入れさせない（CSV 取込と同じ扱い）。
    guestCount: entry.isOccupied ? entry.guestCount : 0,
    adultCount: entry.isOccupied ? entry.adultCount : 0,
    childCount: entry.isOccupied ? entry.childCount : 0,
    reservationRef: entry.reservationRef,
    channelCode: entry.channelCode,
    checkInAt: entry.checkInAt,
    checkOutAt: entry.checkOutAt,
    isStayover: entry.isStayover,
    nightsTotal: entry.nightsTotal,
    nightIndex: entry.nightIndex,
    ratePlanCode: entry.ratePlanCode,
    isComplimentary: entry.isComplimentary,
    isHouseUse: entry.isHouseUse,
    rawPayload: null,
  }));

  const result = await upsertOccupancySnapshots(
    c.env,
    ctx,
    {
      propertyId: body.data.propertyId,
      businessDate: body.data.businessDate,
      source: "MANUAL",
      importedById: getSession(c).membershipId,
    },
    inputs,
  );

  await recordImportAudit(
    c.env,
    ctx,
    getSession(c).membershipId,
    body.data.propertyId,
    body.data.businessDate,
    "MANUAL",
    result,
  );

  const response: OccupancyImportResponse = {
    businessDate: body.data.businessDate,
    source: "MANUAL",
    inserted: result.inserted,
    updated: result.updated,
    unchanged: result.unchanged,
    unknownRoomNumbers: [],
    skippedLines: [],
  };
  return c.json(response);
});

/**
 * CSV 取込（§8.1）。
 *
 * **読めなかった行を黙って捨てない。** 何行を取り込まなかったかと、
 * 客室マスタに無い部屋番号を返す（`room-plans/import` と同じ形）。
 */
occupancy.post("/import/csv", async (c) => {
  const body = occupancyImportRequestSchema.safeParse(await readJson(c.req.raw));
  if (!body.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "occupancy.write", propertyTarget([body.data.propertyId]));

  const parsed = parseOccupancyCsv(body.data.csv, body.data.businessDate);
  const rooms = await listRooms(c.env, ctx, {
    propertyId: body.data.propertyId,
    isActive: true,
  });
  const roomByNumber = new Map(rooms.map((room) => [room.roomNumber, room.id]));

  const unknownRoomNumbers: string[] = [];
  const inputs: OccupancySnapshotInput[] = [];
  for (const row of parsed.rows) {
    const roomId = roomByNumber.get(row.roomNumber);
    if (roomId === undefined) {
      unknownRoomNumbers.push(row.roomNumber);
      continue;
    }
    inputs.push({
      roomId,
      isOccupied: row.isOccupied,
      guestCount: row.guestCount,
      // §8.1 の列に大人・小人の別が無い。**推測で割らない。**
      adultCount: 0,
      childCount: 0,
      reservationRef: row.reservationRef,
      // §8.1 の列に販売経路・料金プランが無い。
      channelCode: null,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      isStayover: row.isStayover,
      nightsTotal: row.nightsTotal,
      nightIndex: row.nightIndex,
      ratePlanCode: null,
      // §8.1 の列に招待・無償が無い。既定の false のまま。
      isComplimentary: false,
      isHouseUse: row.isHouseUse,
      rawPayload: null,
    });
  }

  const result = await upsertOccupancySnapshots(
    c.env,
    ctx,
    {
      propertyId: body.data.propertyId,
      businessDate: body.data.businessDate,
      source: "CSV_IMPORT",
      importedById: getSession(c).membershipId,
    },
    inputs,
  );

  await recordImportAudit(
    c.env,
    ctx,
    getSession(c).membershipId,
    body.data.propertyId,
    body.data.businessDate,
    "CSV_IMPORT",
    result,
  );

  const response: OccupancyImportResponse = {
    businessDate: body.data.businessDate,
    source: "CSV_IMPORT",
    inserted: result.inserted,
    updated: result.updated,
    unchanged: result.unchanged,
    unknownRoomNumbers,
    skippedLines: parsed.skippedLines,
  };
  return c.json(response);
});

export default occupancy;
