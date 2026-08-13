/**
 * 忘れ物の API（PK-SPEC-P2 §14.3）。
 *
 * ```
 * POST   /api/v1/lost-items
 * GET    /api/v1/lost-items?propertyId=&status=
 * GET    /api/v1/lost-items/:id
 * PATCH  /api/v1/lost-items/:id/status
 * POST   /api/v1/lost-items/:id/owner-contacted   （§14.3 に無い追加）
 * ```
 *
 * task: docs/tasks/P2-11.md
 *
 * ── 写真は 4 経路で同じ手順を通る ───────────────────────
 * `POST /:id/photos` は `multipart/form-data`。サイズ・形式の検査から
 * EXIF 除去・ハッシュ・R2 までは `lib/photo/pipeline.ts` に固定してあり、
 * 清掃（P1-11）・検査（P2-04）・忘れ物・不具合が同じ順序を通る
 * （P2-13 が抽出した / OPEN_QUESTIONS #051 の回答）。
 *
 * ── `owner-contacted` を足してある ──────────────────────
 * §7.4「連絡は PMS 側で行い、ProofKeeping には `ownerContactedAt` のみ
 * 記録する」。記録する口が無いと列が永久に `null` のままになる。
 * **本文を取らない。** 誰にどう連絡したかを受け取れる形にすると、
 * security.md §3 が禁じる情報の置き場ができる。
 */

import {
  lostItemCreateRequestSchema,
  lostItemStatusRequestSchema,
  type LostItemError,
  type LostItemSummary,
  type PhotoError,
} from "@pk/contracts";
import {
  findLostItemById,
  findPropertyById,
  findRoomById,
  listLostItemHistory,
  listLostItemPhotos,
  markOwnerContacted,
  type LostItemFilter,
  type LostItemStatus,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { businessDateOf } from "../../../lib/businessDate.js";
import {
  changeLostItemStatus,
  listVisibleLostItems,
  registerLostItem,
  toLostItemSummary,
} from "../../../lib/report/lostItem.js";
import { uploadLostItemPhoto } from "../../../lib/photo/reportUpload.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getNow, getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const lostItems = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): LostItemError {
  return { error: "INVALID_REQUEST" };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 一覧（§7）。
 *
 * **`CLEANER` は自分が登録したものだけ**（§7.4）。絞りは
 * `listVisibleLostItems()` が掛ける。クエリで `foundById` を
 * 受け取らないのは、他人の ID を送れる口を作らないため。
 */
lostItems.get("/", async (c) => {
  const propertyId = c.req.query("propertyId");
  if (propertyId === undefined) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "lostItem.read", propertyTarget([propertyId]));

  const statusParam = c.req.query("status");
  const filter: LostItemFilter = {
    propertyId,
    ...(statusParam === undefined
      ? {}
      : { status: statusParam.split(",") as readonly LostItemStatus[] }),
  };

  const data = await listVisibleLostItems(c.env, ctx, getSession(c).membershipId, filter);
  return c.json({ data });
});

/** 1 件（§7）。**保管場所の出し分けは `toLostItemSummary()` が行う。** */
lostItems.get("/:lostItemId", async (c) => {
  const ctx = getTenant(c);
  const row = await findLostItemById(c.env, ctx, c.req.param("lostItemId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "lostItem.read", propertyTarget([row.propertyId]));

  // §7.4「自分が登録した内容の閲覧」。**他人の登録は 404**（403 にしない / INV-31）。
  if (ctx.role === "CLEANER" && row.foundById !== getSession(c).membershipId) {
    return c.notFound();
  }

  const body: { data: LostItemSummary; history: unknown } = {
    data: toLostItemSummary(ctx, row),
    history: await listLostItemHistory(c.env, ctx, row.id),
  };
  return c.json(body);
});

/**
 * 登録（§7.1）。
 *
 * **施設は客室から解決する**（INV-32）。リクエストの `propertyId` を
 * 権限の対象にしない。
 */
lostItems.post("/", async (c) => {
  const parsed = lostItemCreateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const room = await findRoomById(c.env, ctx, parsed.data.roomId);
  if (room === undefined) return c.notFound();
  assertPermission(ctx, "lostItem.write", propertyTarget([room.propertyId]));

  const property = await findPropertyById(c.env, ctx, room.propertyId);
  const now = getNow(c);

  const outcome = await registerLostItem(c.env, ctx, {
    propertyId: room.propertyId,
    roomId: room.id,
    taskId: parsed.data.taskId ?? null,
    // **業務日はサーバーが決める**（architecture.md §7 / `contracts/report.ts`）。
    businessDate: businessDateOf(now, property?.timezone, property?.dayCutoffTime),
    category: parsed.data.category,
    description: parsed.data.description,
    foundLocation: parsed.data.foundLocation,
    foundById: getSession(c).membershipId,
    // 施設ごとの保持日数はまだ列を持たない。**既定に任せる**（engine が当てる）。
    // 施設設定を足す task がここへ値を渡す（OPEN_QUESTIONS #052）。
    propertyRetentionDays: null,
    ...(c.req.header("CF-Connecting-IP") === undefined
      ? {}
      : { ip: c.req.header("CF-Connecting-IP") }),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies LostItemError, 409);
  }
  return c.json({ lostItemId: outcome.lostItemId, managementNo: outcome.managementNo }, 201);
});

/**
 * 状態の更新（§7.1）。
 *
 * **現在の状態はサーバーが読む**（`contracts/report.ts` の注記）。
 * 楽観的排他に負けたら `INVALID_TRANSITION`。
 */
lostItems.patch("/:lostItemId/status", async (c) => {
  const parsed = lostItemStatusRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  const row = await findLostItemById(c.env, ctx, c.req.param("lostItemId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "lostItem.manage", propertyTarget([row.propertyId]));

  const outcome = await changeLostItemStatus(c.env, ctx, {
    lostItemId: row.id,
    from: row.status,
    to: parsed.data.to,
    propertyId: row.propertyId,
    actorId: getSession(c).membershipId,
    note: parsed.data.note ?? null,
    ...(parsed.data.storageLocation === undefined
      ? {}
      : { storageLocation: parsed.data.storageLocation }),
    ...(parsed.data.policeReportNo === undefined
      ? {}
      : { policeReportNo: parsed.data.policeReportNo }),
    ...(parsed.data.disposalReason === undefined
      ? {}
      : { disposalReason: parsed.data.disposalReason }),
  });

  if (outcome.kind === "REJECTED") {
    return c.json({ error: outcome.error } satisfies LostItemError, 409);
  }
  return c.json({ status: parsed.data.to });
});

/**
 * 持ち主へ連絡したことを記録する（§7.4）。**本文を取らない**（冒頭の注記）。
 *
 * 冪等: 何度呼んでも `ownerContactedAt` が現在時刻で上書きされるだけ。
 * **「最後に連絡した時刻」として正しい。**
 */
lostItems.post("/:lostItemId/owner-contacted", async (c) => {
  const ctx = getTenant(c);
  const row = await findLostItemById(c.env, ctx, c.req.param("lostItemId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "lostItem.manage", propertyTarget([row.propertyId]));

  await markOwnerContacted(c.env, ctx, row.id);
  return c.json({ ownerContactedAtMs: getNow(c).getTime() });
});

/**
 * 写真の一覧（§7.5）。**15 分有効の署名付き URL**（security.md §4）。
 */
lostItems.get("/:lostItemId/photos", async (c) => {
  const ctx = getTenant(c);
  const row = await findLostItemById(c.env, ctx, c.req.param("lostItemId"));
  if (row === undefined) return c.notFound();
  assertPermission(ctx, "lostItem.read", propertyTarget([row.propertyId]));
  if (ctx.role === "CLEANER" && row.foundById !== getSession(c).membershipId) {
    return c.notFound();
  }

  const rows = await listLostItemPhotos(c.env, ctx, row.id);
  return c.json({
    data: await Promise.all(
      rows.map(async (photo) => ({
        photoId: photo.id,
        url: await signObjectUrl(c.env.SESSION_SECRET, photo.storageKey, getNow(c)),
      })),
    ),
  });
});

/**
 * 写真のアップロード（§7.5「忘れ物全体が分かる写真 1 枚を必須」）。
 *
 * **`multipart/form-data`。** `clientId`（冪等鍵）を取らない理由は
 * `lib/photo/reportUpload.ts` の注記。EXIF の除去はサーバー側でも行う
 * （クライアントの再エンコードと合わせて 2 重 / INV-11）。
 */
lostItems.post("/:lostItemId/photos", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "INVALID_REQUEST" } satisfies PhotoError, 400);
  }

  const outcome = await uploadLostItemPhoto(c.env, getTenant(c), {
    lostItemId: c.req.param("lostItemId"),
    bytes: new Uint8Array(await file.arrayBuffer()),
    uploadedById: getSession(c).membershipId,
  });

  if (outcome.kind === "REJECTED") {
    // 対象が無い・他人の登録は 404 へ寄せる（INV-31）。
    if (outcome.error === "INVALID_REQUEST") return c.notFound();
    return c.json({ error: outcome.error } satisfies PhotoError, 400);
  }
  return c.json({ photoId: outcome.photoId }, 201);
});

export default lostItems;
