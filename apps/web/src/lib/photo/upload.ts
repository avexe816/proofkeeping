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
 *   4. 枚数・サイズ・形式の検査
 *   5. **EXIF を落とす**（`sanitizeImage()` / INV-11）
 *   6. R2 へ置く → メタデータを INSERT
 *
 * **5 を 6 より前に置くこと。** 逆にすると、落とす前のバイト列が R2 に残る。
 */

import {
  MAX_PHOTOS_PER_TASK,
  MAX_PHOTO_BYTES,
  type PhotoErrorCode,
  type PhotoKindValue,
} from "@pk/contracts";
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
import { sha256Hex } from "../evidence/hash.js";

import { sanitizeImage } from "./image.js";

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

  if (input.bytes.byteLength > MAX_PHOTO_BYTES) {
    return { kind: "REJECTED", error: "PHOTO_TOO_LARGE" };
  }

  const count = await countTaskPhotos(env, ctx, input.taskId);
  if (count >= MAX_PHOTOS_PER_TASK) {
    return { kind: "REJECTED", error: "PHOTO_LIMIT_EXCEEDED" };
  }

  // **ここで位置情報が落ちる。** 落とせない形式は受け付けない。
  const sanitized = sanitizeImage(input.bytes);
  if (sanitized === null) return { kind: "REJECTED", error: "UNSUPPORTED_IMAGE" };

  const photoId = newPhotoId(ctx);
  const storageKey = photoStorageKey({
    organizationId: ctx.organizationId,
    propertyId: task.propertyId,
    businessDate: task.businessDate,
    taskId: task.id,
    photoId,
    extension: sanitized.format === "image/png" ? "png" : "jpg",
  });

  // **EXIF を落としたあとのバイト列をハッシュする**（§6.3）。落とす前を
  // ハッシュすると、R2 に置いた実体と値が合わず照合が常に失敗する。
  const sha256 = await sha256Hex(sanitized.bytes);

  await env.PHOTOS.put(storageKey, sanitized.bytes, {
    httpMetadata: { contentType: sanitized.format },
    // **R2 側にも残す**（§6.3「DB の sha256 と R2 object metadata の双方へ保存」）。
    customMetadata: { sha256 },
  });

  const created = await createTaskPhoto(env, ctx, {
    taskId: task.id,
    propertyId: task.propertyId,
    checklistItemId: input.checklistItemId ?? null,
    kind: input.kind,
    storageKey,
    photoId,
    sha256,
    width: sanitized.size.width,
    height: sanitized.size.height,
    fileSize: sanitized.bytes.byteLength,
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
