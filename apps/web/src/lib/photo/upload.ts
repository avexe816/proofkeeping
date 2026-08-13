/**
 * 写真アップロードのユースケース（PK-SPEC-P1 §7）。
 *
 * task:  docs/tasks/P1-11.md
 * ルール: .claude/rules/security.md §4
 *
 * ── 呼ぶ順序 ────────────────────────────────────────────
 *   1. タスクを引く（施設は**資源から解決する** / INV-32）
 *   2. `assertPermission("task.write")`
 *   3. `clientId` の照合（再送なら R2 へ書かない / §7.5）
 *   4. 枚数の検査
 *   5. `storePhoto()` … サイズ・形式の検査 → **EXIF 除去** → ハッシュ → R2
 *   6. メタデータを INSERT
 *
 * **5 の中の順序は `lib/photo/pipeline.ts` に固定してある。** 4 経路
 * （清掃 / 検査 / 忘れ物 / 不具合）が同じ手順を通る。
 */

import { MAX_PHOTOS_PER_TASK, type PhotoErrorCode, type PhotoKindValue } from "@pk/contracts";
import {
  countTaskPhotos,
  createTaskPhoto,
  findTaskById,
  findTaskPhotoByClientId,
  newPhotoId,
  type Env,
  type TenantContext,
} from "@pk/db";

import { assertPermission, propertyTarget } from "../auth/permission.js";

import { storePhoto } from "./pipeline.js";

/** R2 のキーの接頭辞（security.md §4）。 */
export const PHOTOS_PREFIX = "photos/";

/**
 * 写真の R2 キー。
 *
 * ```
 * photos/{orgId}/{propertyId}/{businessDate}/{taskId}/{photoId}.jpg
 * ```
 *
 * **業務日を含む**（architecture.md §7）。保持期間の掃除（既定 6 か月 /
 * 上位プランで 13 か月）はこの区切りで走る。カレンダー日で切ると、
 * 深夜の作業が前日の束に入らない。
 */
export function photoStorageKey(input: {
  organizationId: string;
  propertyId: string;
  businessDate: string;
  taskId: string;
  photoId: string;
  extension: "jpg" | "png";
}): string {
  return (
    `${PHOTOS_PREFIX}${input.organizationId}/${input.propertyId}/` +
    `${input.businessDate}/${input.taskId}/${input.photoId}.${input.extension}`
  );
}

/** そのキーがこのテナントのものか。**署名の検証とは別に見る。** */
export function isOwnPhotoKey(key: string, organizationId: string): boolean {
  return key.startsWith(`${PHOTOS_PREFIX}${organizationId}/`);
}

/** アップロードの入力。 */
export interface UploadPhotoInput {
  taskId: string;
  clientId: string;
  kind: PhotoKindValue;
  checklistItemId?: string | undefined;
  bytes: Uint8Array;
  /** アップロードした `membership.id`。 */
  uploadedById: string;
}

/** アップロードの結果。 */
export type UploadPhotoOutcome =
  | {
      kind: "OK";
      unchanged: boolean;
      photo: {
        photoId: string;
        taskId: string;
        storageKey: string;
        /** バイナリの SHA-256（PK-SPEC-P2 §6.3）。**P2-08 より前の行は `null`。** */
        sha256: string | null;
        photoKind: PhotoKindValue;
        checklistItemId: string | null;
        width: number;
        height: number;
        fileSize: number;
        capturedAt: number | null;
        uploadedAt: number;
      };
    }
  | { kind: "REJECTED"; error: PhotoErrorCode };

/**
 * 写真を 1 枚受け取る。
 *
 * @throws {NotFoundError} タスクが無い・別テナント・権限が無い（すべて 404 / INV-31）。
 */
export async function uploadPhoto(
  env: Env,
  ctx: TenantContext,
  input: UploadPhotoInput,
): Promise<UploadPhotoOutcome> {
  const task = await findTaskById(env, ctx, input.taskId);
  if (task === undefined) {
    // 呼び出し側が 404 へ写す。**403 を返さない**（INV-31）。
    return { kind: "REJECTED", error: "INVALID_REQUEST" };
  }
  assertPermission(ctx, "task.write", propertyTarget([task.propertyId]));

  // 再送。**R2 へ触らずに既存を返す**（§7.5）。
  const existing = await findTaskPhotoByClientId(env, ctx, input.clientId);
  if (existing !== undefined) {
    return {
      kind: "OK",
      unchanged: true,
      photo: {
        photoId: existing.id,
        taskId: existing.taskId,
        storageKey: existing.storageKey,
        sha256: existing.sha256,
        photoKind: existing.kind,
        checklistItemId: existing.checklistItemId,
        width: existing.width,
        height: existing.height,
        fileSize: existing.fileSize,
        capturedAt: existing.capturedAt?.getTime() ?? null,
        uploadedAt: existing.uploadedAt.getTime(),
      },
    };
  }

  const count = await countTaskPhotos(env, ctx, input.taskId);
  if (count >= MAX_PHOTOS_PER_TASK) {
    return { kind: "REJECTED", error: "PHOTO_LIMIT_EXCEEDED" };
  }

  const photoId = newPhotoId(ctx);
  // 大きさの検査 → EXIF 除去 → ハッシュ → R2（`lib/photo/pipeline.ts`）。
  // **順序はそこに固定してある。** ここで並べ替えないこと。
  const stored = await storePhoto(env, input.bytes, (extension) =>
    photoStorageKey({
      organizationId: ctx.organizationId,
      propertyId: task.propertyId,
      businessDate: task.businessDate,
      taskId: task.id,
      photoId,
      extension,
    }),
  );
  if (stored.kind === "REJECTED") return stored;

  const created = await createTaskPhoto(env, ctx, {
    taskId: task.id,
    propertyId: task.propertyId,
    checklistItemId: input.checklistItemId ?? null,
    kind: input.kind,
    storageKey: stored.photo.storageKey,
    photoId,
    sha256: stored.photo.sha256,
    width: stored.photo.width,
    height: stored.photo.height,
    fileSize: stored.photo.fileSize,
    clientId: input.clientId,
    uploadedById: input.uploadedById,
  });
  if (created === undefined) return { kind: "REJECTED", error: "INVALID_REQUEST" };

  return {
    kind: "OK",
    unchanged: !created.created,
    photo: {
      photoId: created.row.id,
      taskId: created.row.taskId,
      storageKey: created.row.storageKey,
      sha256: created.row.sha256,
      photoKind: created.row.kind,
      checklistItemId: created.row.checklistItemId,
      width: created.row.width,
      height: created.row.height,
      fileSize: created.row.fileSize,
      capturedAt: created.row.capturedAt?.getTime() ?? null,
      uploadedAt: created.row.uploadedAt.getTime(),
    },
  };
}
