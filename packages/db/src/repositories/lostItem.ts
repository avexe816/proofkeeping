/**
 * 忘れ物のリポジトリ（PK-SPEC-P2 §3.5 / §7）。
 *
 * task:  docs/tasks/P2-11.md
 * ルール: .claude/rules/security.md §3（保存してはいけないデータ）
 *
 * ── 持ち主の情報を受け取る関数が 1 つも無い ─────────────
 * §7.4 / security.md §3。氏名・住所・電話番号を受け取る引数を
 * **後から足さないこと。** 連絡した事実は `ownerContactedAt`（時刻）だけ。
 *
 * ── 物理削除しない ──────────────────────────────────────
 * `db.delete(lostItem)` を書かない。**廃棄は状態（`DISPOSED`）で表す。**
 * `repositories.spec.ts` が全リポジトリのソースを走査して固定する。
 *
 * ── 採番に `DocumentSequencer` を使わない ───────────────
 * 管理番号（§7.2）は請求書・領収書の番号（billing.md §5）と性格が違う。
 * **欠番があってよく、会計年度の切替も無い。** Durable Object は
 * architecture.md §4 の 4 用途に限られ、忘れ物の採番はそこに無い。
 * 「その施設・その業務日の最大値 + 1」を UNIQUE 制約で守る形にしてある
 * （衝突したら呼び出し側が採り直す / `createLostItem()` の注記）。
 */

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  lostItem,
  lostItemHistory,
  lostItemPhoto,
  type LostItemCategory,
  type LostItemStatus,
} from "../schema/report.js";

import { withTenantScope } from "./base.js";

/** 一覧の絞り込み。 */
export interface LostItemFilter {
  propertyId?: string | undefined;
  status?: readonly LostItemStatus[] | undefined;
  /** 業務日（両端を含む）。 */
  businessDateFrom?: string | undefined;
  businessDateTo?: string | undefined;
  /** 発見者（`membership.id`）。**`CLEANER` の「自分が登録した分」に使う**（§7.4）。 */
  foundById?: string | undefined;
}

/** 一覧。**発見が新しい順。** */
export async function listLostItems(env: Env, ctx: TenantContext, filter: LostItemFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(lostItem)
    .where(
      withTenantScope(
        lostItem,
        ctx,
        lostItem.propertyId,
        filter.propertyId === undefined ? undefined : eq(lostItem.propertyId, filter.propertyId),
        filter.status === undefined || filter.status.length === 0
          ? undefined
          : inArray(lostItem.status, [...filter.status]),
        filter.businessDateFrom === undefined
          ? undefined
          : gte(lostItem.businessDate, filter.businessDateFrom),
        filter.businessDateTo === undefined
          ? undefined
          : lte(lostItem.businessDate, filter.businessDateTo),
        filter.foundById === undefined ? undefined : eq(lostItem.foundById, filter.foundById),
      ),
    )
    .orderBy(desc(lostItem.foundAt), desc(lostItem.id));
}

/** 1 件。 */
export async function findLostItemById(env: Env, ctx: TenantContext, lostItemId: string) {
  assertIdBelongsToTenant(lostItemId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(lostItem)
    .where(withTenantScope(lostItem, ctx, lostItem.propertyId, eq(lostItem.id, lostItemId)))
    .limit(1);
  return rows[0];
}

/**
 * その施設・その業務日で使われている連番の最大値。
 *
 * 管理番号は `LNF-{施設コード}-{YYYYMMDD}-{4桁}`（§7.2）。**末尾を数として
 * 見る。** 桁が伸びた番号（10000 以上）も正しく比べられるよう、
 * 文字列の最大ではなく数の最大を取る。
 *
 * @returns 0 件なら `0`。呼び出し側は +1 して使う。
 */
export async function maxLostItemSequence(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
): Promise<number> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ managementNo: lostItem.managementNo })
    .from(lostItem)
    .where(
      withTenantScope(
        lostItem,
        ctx,
        lostItem.propertyId,
        eq(lostItem.propertyId, propertyId),
        eq(lostItem.businessDate, businessDate),
      ),
    );

  let max = 0;
  for (const row of rows) {
    const tail = row.managementNo.split("-").at(-1) ?? "";
    const value = Number(tail);
    if (Number.isInteger(value) && value > max) max = value;
  }
  return max;
}

/** `createLostItem()` の入力。**持ち主に関する値を 1 つも取らない。** */
export interface CreateLostItemInput {
  propertyId: string;
  taskId: string | null;
  roomId: string;
  businessDate: string;
  managementNo: string;
  category: LostItemCategory;
  /** 品物の説明。**持ち主のことを書く欄ではない**（§7.5）。 */
  description: string;
  foundAt: Date;
  foundById: string;
  foundLocation: string;
  /** 保持期限（§7.3）。**過ぎても何も起きない。** */
  retentionDueAt: Date | null;
}

/** 登録の結果。 */
export type CreateLostItemResult =
  | { kind: "CREATED"; lostItemId: string }
  /** 管理番号が衝突した。**呼び出し側が採り直す**（冒頭の注記）。 */
  | { kind: "DUPLICATE_NUMBER" };

/**
 * 忘れ物を 1 件登録する（§7.1 の「発見」）。
 *
 * 状態は `FOUND` から始まり、履歴に 1 行（`fromStatus = null`）を残す。
 * **登録と履歴を 1 回のバッチで書く。** D1 にトランザクションが無いので、
 * `batch()` で 2 文をまとめる（片方だけ残ると履歴の連なりが切れる）。
 */
export async function createLostItem(
  env: Env,
  ctx: TenantContext,
  input: CreateLostItemInput,
): Promise<CreateLostItemResult> {
  assertIdBelongsToTenant(input.propertyId, ctx);
  assertIdBelongsToTenant(input.roomId, ctx);
  if (input.taskId !== null) assertIdBelongsToTenant(input.taskId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "lost");
  try {
    await db.batch([
      db.insert(lostItem).values({
        id,
        organizationId: ctx.organizationId,
        propertyId: input.propertyId,
        taskId: input.taskId,
        roomId: input.roomId,
        businessDate: input.businessDate,
        managementNo: input.managementNo,
        category: input.category,
        description: input.description,
        foundAt: input.foundAt,
        foundById: input.foundById,
        foundLocation: input.foundLocation,
        status: "FOUND",
        retentionDueAt: input.retentionDueAt,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      }),
      db.insert(lostItemHistory).values({
        id: generateId(ctx.orgShortId, "lost"),
        organizationId: ctx.organizationId,
        propertyId: input.propertyId,
        lostItemId: id,
        fromStatus: null,
        toStatus: "FOUND",
        actorId: input.foundById,
        note: null,
        occurredAt: ctx.now,
      }),
    ]);
  } catch (error) {
    // UNIQUE(organizationId, propertyId, managementNo) の衝突だけを
    // 拾う。**他の失敗を握り潰さない。**
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") && message.includes("management_no")) {
      return { kind: "DUPLICATE_NUMBER" };
    }
    throw error;
  }

  return { kind: "CREATED", lostItemId: id };
}

/** `advanceLostItem()` の入力。 */
export interface AdvanceLostItemInput {
  lostItemId: string;
  /** 期待する現在の状態。**これと違えば書かない**（楽観的排他）。 */
  from: LostItemStatus;
  to: LostItemStatus;
  actorId: string;
  note: string | null;
  /** 保管場所（`STORED` へ進むとき）。**`CLEANER` には返さない**（§7.4）。 */
  storageLocation?: string | null | undefined;
  policeReportNo?: string | null | undefined;
  /** 廃棄の理由（`DISPOSED` へ進むとき）。§7.3 の「明示操作」の記録。 */
  disposalReason?: string | null | undefined;
}

/** 遷移の結果。 */
export type AdvanceLostItemResult =
  | { kind: "ADVANCED" }
  /** 期待した状態と違った（並行操作・再送）。**成功にも失敗にもしない。** */
  | { kind: "NOOP" };

/**
 * 状態を進める（§7.1）。
 *
 * **`status = from` の行にしか当たらない。** 再送は 0 行更新になり `NOOP`。
 * 履歴は更新が成功したときだけ足す（testing.md §4 の冪等）。
 *
 * ── 時刻の列を `to` から決める ──────────────────────────
 * `policeReportedAt` / `returnedAt` / `disposedAt` は、その状態へ
 * 進んだときにだけ入る。**呼び出し側から時刻を受け取らない**
 * （「返却済にしたが返却日は 1 年前」を書ける形にしない）。
 */
export async function advanceLostItem(
  env: Env,
  ctx: TenantContext,
  input: AdvanceLostItemInput,
): Promise<AdvanceLostItemResult> {
  assertIdBelongsToTenant(input.lostItemId, ctx);
  const db = await getTenantDb(env, ctx);

  const result = await db
    .update(lostItem)
    .set({
      status: input.to,
      ...(input.storageLocation === undefined ? {} : { storageLocation: input.storageLocation }),
      ...(input.policeReportNo === undefined ? {} : { policeReportNo: input.policeReportNo }),
      ...(input.disposalReason === undefined ? {} : { disposalReason: input.disposalReason }),
      ...(input.to === "REPORTED_TO_POLICE" ? { policeReportedAt: ctx.now } : {}),
      ...(input.to === "RETURNED" ? { returnedAt: ctx.now } : {}),
      ...(input.to === "DISPOSED" ? { disposedAt: ctx.now } : {}),
      updatedAt: ctx.now,
    })
    .where(
      and(
        eq(lostItem.organizationId, ctx.organizationId),
        eq(lostItem.id, input.lostItemId),
        eq(lostItem.status, input.from),
      ),
    );

  // `meta.changes` は D1 が必ず返す（型も `number`）。0 は「その行が
  // 期待した状態でなかった」＝再送・並行操作。
  if (result.meta.changes === 0) return { kind: "NOOP" };

  const row = await findLostItemById(env, ctx, input.lostItemId);
  await db.insert(lostItemHistory).values({
    id: generateId(ctx.orgShortId, "lost"),
    organizationId: ctx.organizationId,
    propertyId: row?.propertyId ?? "",
    lostItemId: input.lostItemId,
    fromStatus: input.from,
    toStatus: input.to,
    actorId: input.actorId,
    note: input.note,
    occurredAt: ctx.now,
  });

  return { kind: "ADVANCED" };
}

/** 持ち主へ連絡した時刻を記録する（§7.4）。**連絡先そのものは持たない。** */
export async function markOwnerContacted(
  env: Env,
  ctx: TenantContext,
  lostItemId: string,
): Promise<void> {
  assertIdBelongsToTenant(lostItemId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(lostItem)
    .set({ ownerContactedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(lostItem.organizationId, ctx.organizationId), eq(lostItem.id, lostItemId)));
}

/** 状態履歴。**古い順。** */
export async function listLostItemHistory(env: Env, ctx: TenantContext, lostItemId: string) {
  assertIdBelongsToTenant(lostItemId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(lostItemHistory)
    .where(
      withTenantScope(
        lostItemHistory,
        ctx,
        lostItemHistory.propertyId,
        eq(lostItemHistory.lostItemId, lostItemId),
      ),
    )
    .orderBy(lostItemHistory.occurredAt, lostItemHistory.id);
}

/** 写真。**全体が分かる 1 枚が必須**（§7.5。必須判定は呼び出し側）。 */
export async function listLostItemPhotos(env: Env, ctx: TenantContext, lostItemId: string) {
  assertIdBelongsToTenant(lostItemId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(lostItemPhoto)
    .where(
      withTenantScope(
        lostItemPhoto,
        ctx,
        lostItemPhoto.propertyId,
        eq(lostItemPhoto.lostItemId, lostItemId),
      ),
    )
    .orderBy(lostItemPhoto.uploadedAt, lostItemPhoto.id);
}

/** `createLostItemPhoto()` の入力。 */
export interface CreateLostItemPhotoInput {
  lostItemId: string;
  propertyId: string;
  storageKey: string;
  /** **必須。** アップロード時にサーバーが計算した値（§6.3）。 */
  sha256: string;
  uploadedById: string;
}

/** 写真を 1 枚足す。 */
export async function createLostItemPhoto(
  env: Env,
  ctx: TenantContext,
  input: CreateLostItemPhotoInput,
): Promise<{ photoId: string }> {
  assertIdBelongsToTenant(input.lostItemId, ctx);
  assertIdBelongsToTenant(input.propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  const id = generateId(ctx.orgShortId, "lost");
  await db.insert(lostItemPhoto).values({
    id,
    organizationId: ctx.organizationId,
    propertyId: input.propertyId,
    lostItemId: input.lostItemId,
    storageKey: input.storageKey,
    sha256: input.sha256,
    uploadedAt: ctx.now,
    uploadedById: input.uploadedById,
  });
  return { photoId: id };
}

/** 写真の枚数（必須 1 枚の判定に使う）。 */
export async function countLostItemPhotos(
  env: Env,
  ctx: TenantContext,
  lostItemId: string,
): Promise<number> {
  assertIdBelongsToTenant(lostItemId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(lostItemPhoto)
    .where(
      withTenantScope(
        lostItemPhoto,
        ctx,
        lostItemPhoto.propertyId,
        eq(lostItemPhoto.lostItemId, lostItemId),
      ),
    );
  return rows[0]?.count ?? 0;
}
