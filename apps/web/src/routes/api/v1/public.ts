/**
 * 公開 API（PK-SPEC-P6 §6.1〜§6.5 / P6-12）。
 *
 * ```
 * POST   /api/v1/public/occupancy/snapshots   occupancy:write
 * POST   /api/v1/public/signals               signals:write
 * GET    /api/v1/public/tasks                 tasks:read
 * GET    /api/v1/public/rooms                 tasks:read
 * GET    /api/v1/public/findings              findings:read
 * GET    /api/v1/public/reports/daily         reports:read
 * GET    /api/v1/public/invoices              invoices:read
 * ```
 *
 * task:  docs/tasks/P6-12.md
 * ルール: .claude/rules/security.md §1・§7・§8
 *
 * ── セッションを持たない経路 ────────────────────────────
 * 認証は `Authorization: Bearer`（`middleware/apiKey.ts`）。
 * **`useTenantMiddleware()` を付けない。** 下流から見た `TenantContext` の
 * 形は同じなので、リポジトリ層の第 1 層（組織条件の強制注入）と
 * 第 2 層（自己記述 ID の照合）はそのまま効く。
 *
 * ── `assertPermission()` を呼ばない（DECISIONS #151）──────
 * 公開 API の認可は**スコープ**（§6.2）で決まる。`TenantContext.role` は
 * リポジトリ層の施設スコープを効かせるためだけの値で、権限判定に
 * 使うと施設を絞ったキーが `PROPERTY_MANAGER` を名乗ることになる。
 * **この不変条件は `public.spec.ts` がソースを走査して固定している。**
 *
 * ── 外部の ID を受け取らない ────────────────────────────
 * 客室は ProofKeeping の `roomId` で指す。外部システムの部屋番号を
 * 受け取る口は**汎用 Webhook**（§4.2）で、あちらは `external_mapping` を
 * 引いて変換する。公開 API は `/public/rooms` で ID を配り、以後は
 * その ID で受ける。**2 つの変換経路を持たない**（DECISIONS #152）。
 *
 * ── 宿泊者の情報を受け取らない ──────────────────────────
 * `occupancySnapshotUpsertRequestSchema` に氏名・連絡先の欄が無い
 * （security.md §3）。公開 API でも同じスキーマを使うので、
 * **外から入れる経路が増えていない。**
 */

import {
  occupancySnapshotUpsertRequestSchema,
  webhookSignalBodySchema,
  webhookSignalEventSchema,
} from "@pk/contracts";
import {
  insertPhysicalSignals,
  listDailyReports,
  listFindings,
  listInvoices,
  listOccupancySnapshots,
  listRooms,
  listTasks,
  upsertOccupancySnapshots,
  type OccupancySnapshotInput,
  type PhysicalSignalInput,
} from "@pk/db";
import { Hono } from "hono";

import { businessDateOf } from "../../../lib/businessDate.js";
import {
  apiKeyMiddleware,
  getApiKey,
  isPropertyAllowed,
  requireEndpointRateLimit,
  requireScope,
  type PublicApiEnv,
} from "../../../middleware/apiKey.js";
import { apiErrorHandler, getTenant } from "../../../middleware/index.js";

const publicApi = new Hono<PublicApiEnv>();

// 例外の写像（越境 ID → 404 など）は認証済みの API と共通。
publicApi.onError(apiErrorHandler());
publicApi.use("*", apiKeyMiddleware());

/** 一覧の既定・上限件数。**無制限にしない。** */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** 400。**理由を細かく返さない。** */
function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** `?limit=` を読む。**上限で頭打ちにする。** */
function readLimit(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** `YYYY-MM-DD` か。 */
function isBusinessDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// ────────────────────────────────────────────────────────────
// 稼働記録の投入（§6.3 / occupancy:write）
// ────────────────────────────────────────────────────────────

/**
 * 稼働記録を入れる。**`source = PMS_API`。**
 *
 * ── なぜ `PMS_API` を名乗ってよいか ──────────────────────
 * `routes/api/v1/occupancy.ts` は「**`PMS_API` を API 越しに名乗る経路を
 * 作らない**」と書いている（P4-02）。あれは**セッションを持つ人の口**の話で、
 * 人が入れた記録と連携が入れた記録の区別を守るためだった。
 *
 * この口は §3.2 が `api-generic`（「顧客が自前で POST する汎用口」）として
 * 定めているもので、**呼んでいるのは人ではなく顧客のシステム。**
 * §3.3 の取込処理も「`OccupancySnapshot` へ UPSERT（`source = PMS_API`）」と
 * 書いている。加えて取込元の優先順位は `MANUAL` > `PMS_API` > `CSV_IMPORT`
 * （DECISIONS #111）なので、**`PMS_API` を名乗っても手入力を上書きしない。**
 * docs/DECISIONS.md #153。
 */
publicApi.post(
  "/occupancy/snapshots",
  requireScope("occupancy:write"),
  requireEndpointRateLimit("publicOccupancy"),
  async (c) => {
    const body = occupancySnapshotUpsertRequestSchema.safeParse(await readJson(c.req.raw));
    if (!body.success) return c.json(invalidRequest(), 400);

    const ctx = getTenant(c);
    // 施設を絞ったキーが担当外の施設へ書けないこと（§8.4）。
    // **404 で返す**（403 は施設の存在を示唆する / architecture.md §2 第 2 層）。
    if (!isPropertyAllowed(getApiKey(c), body.data.propertyId)) return c.notFound();

    const inputs: OccupancySnapshotInput[] = body.data.entries.map((entry) => ({
      roomId: entry.roomId,
      isOccupied: entry.isOccupied,
      // 空室に人数を入れさせない（手入力・CSV 取込と同じ扱い）。
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
        source: "PMS_API",
        // **`membership.id` ではなく API キーの ID。** 人が入れたことに
        // しない。監査で「どのキーが入れたか」を辿れる。
        importedById: getApiKey(c).apiKeyId,
      },
      inputs,
    );

    return c.json({
      businessDate: body.data.businessDate,
      source: "PMS_API" as const,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
    });
  },
);

// ────────────────────────────────────────────────────────────
// 物理信号の投入（§6.3 / signals:write）
// ────────────────────────────────────────────────────────────

/**
 * 物理信号を入れる。
 *
 * **汎用 Webhook（§4.2）との違い。** あちらは署名で守られ、外部の
 * `deviceId` を `external_mapping` で変換し、処理を Queue へ渡す。
 * こちらは API キーで守られ、**ProofKeeping の `roomId` をそのまま受ける。**
 * 変換が要らないぶん同期で書けるが、そのぶん送る側が ID を知っている
 * 必要がある（`/public/rooms` で取る）。
 *
 * 重複排除は `insertPhysicalSignals()` の責務（`(deviceId, type, occurredAt)`）。
 * **同じ本文を 3 回送っても行は増えない**（testing.md §4）。
 */
publicApi.post(
  "/signals",
  requireScope("signals:write"),
  requireEndpointRateLimit("publicSignals"),
  async (c) => {
    const envelope = webhookSignalBodySchema.safeParse(await readJson(c.req.raw));
    if (!envelope.success) return c.json(invalidRequest(), 400);

    const ctx = getTenant(c);
    const key = getApiKey(c);

    // 客室 → 施設。**送られた `roomId` が実在し、キーの施設に収まることを
    // 客室マスタで確かめる。** 越境 ID は `listRooms()` の第 1 層が落とす。
    const rooms = await listRooms(c.env, ctx, {});
    const roomById = new Map(rooms.map((row) => [row.id, row]));

    const signals: PhysicalSignalInput[] = [];
    let skipped = 0;
    for (const raw of envelope.data.events) {
      const parsed = publicSignalEventSchema(raw);
      if (parsed === null) {
        skipped += 1;
        continue;
      }
      const room = roomById.get(parsed.roomId);
      if (room === undefined || !isPropertyAllowed(key, room.propertyId)) {
        // **エラーにしない。** 未知の客室は数えるだけ（§2.3 と同じ方針）。
        skipped += 1;
        continue;
      }
      const occurredAt = new Date(parsed.occurredAt);
      signals.push({
        propertyId: room.propertyId,
        roomId: room.id,
        businessDate: businessDateOf(occurredAt),
        signalType: parsed.type,
        occurredAt,
        // **省略は `null` のまま。`UNKNOWN` へ寄せない**（§4.3 MUST）。
        actorType: parsed.actorType ?? null,
        actorRef: parsed.actorRef ?? null,
        deviceId: parsed.deviceId ?? room.id,
        rawPayload: null,
      });
    }

    const inserted = await insertPhysicalSignals(c.env, ctx, signals);
    return c.json({
      received: envelope.data.events.length,
      applied: inserted.inserted,
      duplicate: inserted.duplicate,
      skipped,
    });
  },
);

/** 公開 API のシグナル 1 件。**`roomId` を足した以外は §4.2 と同じ形。** */
function publicSignalEventSchema(value: unknown): {
  roomId: string;
  type: PhysicalSignalInput["signalType"];
  occurredAt: string;
  actorType?: PhysicalSignalInput["actorType"] | undefined;
  actorRef?: string | undefined;
  deviceId?: string | undefined;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const roomId = record["roomId"];
  if (typeof roomId !== "string" || roomId === "") return null;
  // 種類・時刻・鍵の検証は §4.2 のスキーマを使い回す（`deviceId` を補う）。
  const parsed = webhookSignalEventSchema.safeParse({
    ...record,
    deviceId: typeof record["deviceId"] === "string" ? record["deviceId"] : roomId,
  });
  if (!parsed.success) return null;
  // `z.iso.datetime()` は形しか見ない。**実在しない日付を弾く。**
  if (Number.isNaN(new Date(parsed.data.occurredAt).getTime())) return null;
  return {
    roomId,
    type: parsed.data.type,
    occurredAt: parsed.data.occurredAt,
    actorType: parsed.data.actorType,
    actorRef: parsed.data.actorRef,
    deviceId: parsed.data.deviceId,
  };
}

// ────────────────────────────────────────────────────────────
// 参照（§6.3）
// ────────────────────────────────────────────────────────────

/**
 * 客室（§6.3）。**公開 API の入口。** ここで得た `roomId` を
 * `/occupancy/snapshots` と `/signals` で使う。
 *
 * スコープは `tasks:read`。**§6.2 に客室専用のスコープが無い**ので、
 * 客室を必要とするのがタスクの解釈である以上そこへ寄せた
 * （docs/OPEN_QUESTIONS.md #092）。
 */
publicApi.get("/rooms", requireScope("tasks:read"), async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const rooms = await listRooms(c.env, ctx, {
    ...(propertyId === undefined ? {} : { propertyId }),
    isActive: true,
  });
  return c.json({
    data: rooms.map((row) => ({
      roomId: row.id,
      propertyId: row.propertyId,
      roomNumber: row.roomNumber,
      roomTypeId: row.roomTypeId,
      isSellable: row.isSellable,
    })),
  });
});

/** 清掃タスク（§6.3）。 */
publicApi.get("/tasks", requireScope("tasks:read"), async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const businessDate = c.req.query("businessDate");
  if (businessDate !== undefined && !isBusinessDate(businessDate)) {
    return c.json(invalidRequest(), 400);
  }
  const rows = await listTasks(c.env, ctx, {
    ...(propertyId === undefined ? {} : { propertyId }),
    ...(businessDate === undefined ? {} : { businessDate }),
  });
  return c.json({
    data: rows.slice(0, readLimit(c.req.query("limit"))).map((row) => ({
      taskId: row.id,
      propertyId: row.propertyId,
      roomId: row.roomId,
      businessDate: row.businessDate,
      taskType: row.taskType,
      status: row.status,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      // **担当者を出さない**（security.md §5）。誰が何件やったかを
      // 外部から集計できる形にしない。
    })),
  });
});

/**
 * 差異レポート（§6.3）。
 *
 * **`CLEANER` / `INSPECTOR` の 404 と同じ配慮は要らない。** API キーには
 * ロールが無く、`findings:read` を持たないキーは 403 で止まる（§6.2）。
 * ただし**差異の要約に「不正」の語を出さない**（ui-writing.md §2）のは同じ。
 */
publicApi.get("/findings", requireScope("findings:read"), async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const rows = await listFindings(c.env, ctx, {
    ...(propertyId === undefined ? {} : { propertyId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    limit: readLimit(c.req.query("limit")),
  });
  return c.json({
    data: rows.map((row) => ({
      findingId: row.id,
      propertyId: row.propertyId,
      roomId: row.roomId,
      businessDate: row.businessDate,
      ruleCode: row.ruleCode,
      severity: row.severity,
      confidence: row.confidence,
      status: row.status,
      title: row.title,
    })),
  });
});

/** 日報（§6.3）。**PDF そのものは返さない**（署名付き URL は別経路）。 */
publicApi.get("/reports/daily", requireScope("reports:read"), async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const rows = await listDailyReports(c.env, ctx, {
    ...(propertyId === undefined ? {} : { propertyId }),
    ...(from === undefined ? {} : { businessDateFrom: from }),
    ...(to === undefined ? {} : { businessDateTo: to }),
  });
  return c.json({
    data: rows.slice(0, readLimit(c.req.query("limit"))).map((row) => ({
      reportId: row.id,
      propertyId: row.propertyId,
      businessDate: row.businessDate,
      revision: row.revision,
      documentNo: row.documentNo,
      generatedAt: row.generatedAt.toISOString(),
    })),
  });
});

/** 請求書（§6.3）。**金額は整数（円）のまま返す**（billing.md §4）。 */
publicApi.get("/invoices", requireScope("invoices:read"), async (c) => {
  const ctx = getTenant(c);
  const rows = await listInvoices(c.env, ctx, {
    limit: readLimit(c.req.query("limit")),
  });
  return c.json({
    data: rows.map((row) => ({
      invoiceId: row.id,
      documentNo: row.documentNo,
      issueDate: row.issueDate,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      counterpartyName: row.counterpartyName,
      totalAmount: row.totalAmount,
      status: row.status,
    })),
  });
});

/** 稼働記録の参照。**§6.3 の一覧には無いが、投入した値を確かめる口が要る。** */
publicApi.get("/occupancy", requireScope("occupancy:write"), async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const businessDate = c.req.query("businessDate");
  if (propertyId === undefined || businessDate === undefined) {
    return c.json(invalidRequest(), 400);
  }
  if (!isBusinessDate(businessDate)) return c.json(invalidRequest(), 400);
  if (!isPropertyAllowed(getApiKey(c), propertyId)) return c.notFound();

  const rows = await listOccupancySnapshots(c.env, ctx, { propertyId, businessDate });
  return c.json({
    businessDate,
    data: rows.map((row) => ({
      roomId: row.roomId,
      source: row.source,
      isOccupied: row.isOccupied,
      guestCount: row.guestCount,
      reservationRef: row.reservationRef,
    })),
  });
});

export default publicApi;
