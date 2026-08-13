/**
 * 検査写真のアップロード（PK-SPEC-P2 §4.3 / §6.3）。
 *
 * task:  docs/tasks/P2-04.md
 * ルール: .claude/rules/security.md §4
 *
 * ── 清掃写真と同じ手順で、置き場と表だけを分ける ────────
 * 手順は `lib/photo/upload.ts`（P1-11）と同じ。
 *   1. 検査項目を引く（施設は**資源から解決する** / INV-32）
 *   2. `assertPermission("inspection.write")`
 *   3. `clientId` の照合（再送なら R2 へ書かない）
 *   4. サイズ・形式の検査
 *   5. **EXIF を落とす**（`sanitizeImage()` / INV-11）
 *   6. **SHA-256 を計算する**（§6.3）→ R2 へ置く → メタデータを INSERT
 *
 * **5 を 6 より前に置くこと。** 逆にすると、落とす前のバイト列が R2 に
 * 残り、ハッシュも「落とす前」のものになる（証跡の検証と合わなくなる）。
 *
 * ── ハッシュは R2 のメタデータにも入れる ────────────────
 * P2-08 の完了条件「写真の SHA-256 が DB と R2 metadata の両方に保存される」。
 * **アップロードの瞬間にしか計算できない**ので、ここで両方へ書く。
 */

import { MAX_PHOTO_BYTES, type PhotoErrorCode } from "@pk/contracts";
import {
  createInspectionPhoto,
  findInspectionById,
  findInspectionItemResultById,
  findInspectionPhotoByClientId,
  findTaskById,
  newInspectionPhotoId,
  type Env,
  type TenantContext,
} from "@pk/db";

import { assertPermission, propertyTarget } from "../auth/permission.js";
import { sha256Hex } from "../evidence/hash.js";

import { sanitizeImage } from "./image.js";
import { photoStorageKey } from "./upload.js";

/** アップロードの入力。 */
export interface UploadInspectionPhotoInput {
  inspectionId: string;
  /** どの項目の不合格に対する写真か（`inspectionItemResult.id`）。 */
  itemResultId: string;
  clientId: string;
  bytes: Uint8Array;
  /** アップロードした `membership.id`。 */
  uploadedById: string;
}

/** アップロードの結果。 */
export type UploadInspectionPhotoOutcome =
  | {
      kind: "OK";
      unchanged: boolean;
      photo: {
        photoId: string;
        inspectionId: string;
        itemResultId: string;
        storageKey: string;
        sha256: string;
        width: number;
        height: number;
        fileSize: number;
        uploadedAt: number;
      };
    }
  | { kind: "REJECTED"; error: PhotoErrorCode };

/**
 * 検査写真を 1 枚受け取る。
 *
 * @throws {NotFoundError} 検査が無い・別テナント・権限が無い（すべて 404 / INV-31）。
 */
export async function uploadInspectionPhoto(
  env: Env,
  ctx: TenantContext,
  input: UploadInspectionPhotoInput,
): Promise<UploadInspectionPhotoOutcome> {
  const inspection = await findInspectionById(env, ctx, input.inspectionId);
  if (inspection === undefined) return { kind: "REJECTED", error: "INVALID_REQUEST" };
  assertPermission(ctx, "inspection.write", propertyTarget([inspection.propertyId]));

  // **確定済みの検査へは足せない。** 後から証拠を足せる形にしない。
  if (inspection.result !== null) return { kind: "REJECTED", error: "INVALID_REQUEST" };

  const item = await findInspectionItemResultById(env, ctx, input.itemResultId);
  if (item === undefined || item.inspectionId !== inspection.id) {
    return { kind: "REJECTED", error: "INVALID_REQUEST" };
  }

  // 再送。**R2 へ触らずに既存を返す。**
  const existing = await findInspectionPhotoByClientId(env, ctx, input.clientId);
  if (existing !== undefined) {
    return {
      kind: "OK",
      unchanged: true,
      photo: {
        photoId: existing.id,
        inspectionId: existing.inspectionId,
        itemResultId: existing.itemResultId,
        storageKey: existing.storageKey,
        sha256: existing.sha256,
        width: existing.width,
        height: existing.height,
        fileSize: existing.fileSize,
        uploadedAt: existing.uploadedAt.getTime(),
      },
    };
  }

  if (input.bytes.byteLength > MAX_PHOTO_BYTES) {
    return { kind: "REJECTED", error: "PHOTO_TOO_LARGE" };
  }

  // **ここで位置情報が落ちる。** 落とせない形式は受け付けない。
  const sanitized = sanitizeImage(input.bytes);
  if (sanitized === null) return { kind: "REJECTED", error: "UNSUPPORTED_IMAGE" };

  const task = await findTaskById(env, ctx, inspection.taskId);
  if (task === undefined) return { kind: "REJECTED", error: "INVALID_REQUEST" };

  const photoId = newInspectionPhotoId(ctx);
  const storageKey = photoStorageKey({
    organizationId: ctx.organizationId,
    propertyId: inspection.propertyId,
    businessDate: task.businessDate,
    taskId: task.id,
    photoId,
    extension: sanitized.format === "image/png" ? "png" : "jpg",
  });
  const sha256 = await sha256Hex(sanitized.bytes);

  await env.PHOTOS.put(storageKey, sanitized.bytes, {
    httpMetadata: { contentType: sanitized.format },
    // **R2 側にも残す**（P2-08 の完了条件）。
    customMetadata: { sha256 },
  });

  const created = await createInspectionPhoto(env, ctx, {
    inspectionId: inspection.id,
    itemResultId: item.id,
    propertyId: inspection.propertyId,
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
      inspectionId: created.row.inspectionId,
      itemResultId: created.row.itemResultId,
      storageKey: created.row.storageKey,
      sha256: created.row.sha256,
      width: created.row.width,
      height: created.row.height,
      fileSize: created.row.fileSize,
      uploadedAt: created.row.uploadedAt.getTime(),
    },
  };
}
