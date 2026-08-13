/**
 * 清掃写真のメタデータのリポジトリ（PK-SPEC-P1 §7）。
 *
 * task:  docs/tasks/P1-11.md
 * ルール: .claude/rules/security.md §4
 *
 * **実体は R2、ここはメタデータだけ。** 画像そのものの読み書きは
 * `apps/web` 側（`lib/photo/*`）が行う。
 *
 * ── 削除の関数を置いていない ────────────────────────────
 * P1 の task に写真の削除は無く、INV-27（同期完了まで端末内のデータを
 * 削除しない）と同じ方向で「消せない」側に倒してある。必要になった task が
 * 監査ログとセットで足すこと。
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { taskPhoto, type PhotoKind } from "../schema/task.js";

import { withTenantScope } from "./base.js";

/** タスク 1 件の写真。**アップロード順**（`uploadedAt` 昇順）。 */
export async function listTaskPhotos(env: Env, ctx: TenantContext, taskId: string) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(taskPhoto)
    .where(withTenantScope(taskPhoto, ctx, taskPhoto.propertyId, eq(taskPhoto.taskId, taskId)))
    .orderBy(taskPhoto.uploadedAt);
}

/** タスク 1 件の枚数。**上限（20 枚）の判定に使う。** */
export async function countTaskPhotos(
  env: Env,
  ctx: TenantContext,
  taskId: string,
): Promise<number> {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(taskPhoto)
    .where(withTenantScope(taskPhoto, ctx, taskPhoto.propertyId, eq(taskPhoto.taskId, taskId)));
  return rows[0]?.count ?? 0;
}

/**
 * 施設 × 業務日の写真枚数をタスクごとに数える（客室ボード / §9.5）。
 *
 * task: docs/tasks/P1-15.md
 *
 * **タスクごとに `countTaskPhotos()` を呼ばない。** 100 室の盤面で
 * 100 クエリになり §13 の応答時間を満たせない。1 回で引いて突き合わせる。
 * 施設で絞るのは絞り込みであって権限ではない（判定は `assertPermission()`）。
 */
export async function countPhotosByTask(
  env: Env,
  ctx: TenantContext,
  taskIds: readonly string[],
): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  for (const taskId of taskIds) assertIdBelongsToTenant(taskId, ctx);

  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ taskId: taskPhoto.taskId, count: sql<number>`count(*)` })
    .from(taskPhoto)
    .where(
      withTenantScope(taskPhoto, ctx, taskPhoto.propertyId, inArray(taskPhoto.taskId, [...taskIds])),
    )
    .groupBy(taskPhoto.taskId);
  return new Map(rows.map((row) => [row.taskId, row.count]));
}

/** `clientId` で 1 件引く（§7.5 の冪等性）。 */
export async function findTaskPhotoByClientId(
  env: Env,
  ctx: TenantContext,
  clientId: string,
) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(taskPhoto)
    .where(withTenantScope(taskPhoto, ctx, taskPhoto.propertyId, eq(taskPhoto.clientId, clientId)))
    .limit(1);
  return rows[0];
}

/** `createTaskPhoto()` の入力。**位置情報の項目を持たない**（INV-11）。 */
export interface CreateTaskPhotoInput {
  taskId: string;
  propertyId: string;
  checklistItemId?: string | null | undefined;
  kind: PhotoKind;
  /** R2 のキー。採番済みの `photoId` を含む。 */
  storageKey: string;
  /** `storageKey` に埋めた `photoId`。 */
  photoId: string;
  /**
   * バイナリの SHA-256（PK-SPEC-P2 §6.3）。**サーバーが計算した値。**
   *
   * 省略できるのは、この列が P2-08 で後から足されたため
   * （`schema/task.ts` の注記）。**新しい経路では必ず渡すこと。**
   */
  sha256?: string | null | undefined;
  width: number;
  height: number;
  fileSize: number;
  /** 端末で採番した uuid。 */
  clientId: string;
  /** アップロードした `membership.id`。 */
  uploadedById: string;
}

/** `createTaskPhoto()` の結果。**再送は「既にあった」を返す。** */
export interface CreateTaskPhotoResult {
  created: boolean;
  row: NonNullable<Awaited<ReturnType<typeof findTaskPhotoByClientId>>>;
}

/**
 * 写真のメタデータを 1 件作る。
 *
 * 冪等: `(organizationId, clientId)` の一意制約に任せる。**同じ `clientId` で
 * 再送されたら既存の行を返す**（§7.5）。オフラインキューは同じ写真を
 * 何度も送るので、ここが増える実装だと 1 枚が 5 枚に化ける。
 *
 * **R2 への書き込みより後に呼ぶこと。** 逆にすると、行はあるのに実体が
 * 無い写真ができる。R2 が先なら、失敗しても孤児のオブジェクトが残るだけで
 * 画面には出ない（保持期間の掃除で消える）。
 */
export async function createTaskPhoto(
  env: Env,
  ctx: TenantContext,
  input: CreateTaskPhotoInput,
): Promise<CreateTaskPhotoResult | undefined> {
  assertIdBelongsToTenant(input.taskId, ctx);
  const db = await getTenantDb(env, ctx);

  const result = await db
    .insert(taskPhoto)
    .values({
      id: input.photoId,
      organizationId: ctx.organizationId,
      propertyId: input.propertyId,
      taskId: input.taskId,
      checklistItemId: input.checklistItemId ?? null,
      kind: input.kind,
      storageKey: input.storageKey,
      sha256: input.sha256 ?? null,
      width: input.width,
      height: input.height,
      fileSize: input.fileSize,
      // **サーバー時刻**（PK-IMPL-CONTRACT §2.5）。EXIF の撮影時刻は
      // クライアントの再エンコードで消えており、端末の時計も信用しない。
      capturedAt: ctx.now,
      uploadedAt: ctx.now,
      uploadedById: input.uploadedById,
      clientId: input.clientId,
    })
    .onConflictDoNothing();

  if (result.meta.changes > 0) {
    const row = await findTaskPhotoByClientId(env, ctx, input.clientId);
    return row === undefined ? undefined : { created: true, row };
  }

  const existing = await findTaskPhotoByClientId(env, ctx, input.clientId);
  return existing === undefined ? undefined : { created: false, row: existing };
}

/**
 * 写真 1 件を引く（署名付き URL の発行前に施設を解決するため）。
 *
 * **`storageKey` から施設を読み取らない。** キーは文字列で、行から解決した
 * `propertyId` だけが権限判定に使える値（INV-32 と同じ理由）。
 */
export async function findTaskPhotoById(env: Env, ctx: TenantContext, photoId: string) {
  assertIdBelongsToTenant(photoId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(taskPhoto)
    .where(withTenantScope(taskPhoto, ctx, taskPhoto.propertyId, eq(taskPhoto.id, photoId)))
    .limit(1);
  return rows[0];
}

/** 新しい写真の ID を採番する。**`storageKey` に埋めるので事前に要る。** */
export function newPhotoId(ctx: TenantContext): string {
  return generateId(ctx.orgShortId, "photo");
}

/** チェックリスト項目に紐づく写真だけを引く（M-04 の 📷 表示）。 */
export async function listPhotosForChecklistItem(
  env: Env,
  ctx: TenantContext,
  taskId: string,
  checklistItemId: string,
) {
  assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(taskPhoto)
    .where(
      withTenantScope(
        taskPhoto,
        ctx,
        taskPhoto.propertyId,
        and(eq(taskPhoto.taskId, taskId), eq(taskPhoto.checklistItemId, checklistItemId)),
      ),
    )
    .orderBy(taskPhoto.uploadedAt);
}
