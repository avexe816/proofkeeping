/**
 * 写真の受け取りで**必ず同じ順序で起きること**（security.md §4 / PK-SPEC-P2 §6.3）。
 *
 * task: docs/tasks/P2-13.md（P1-11 / P2-04 から抽出）
 *
 * ```
 * 大きさの検査 → EXIF を落とす → SHA-256 → R2 へ置く
 * ```
 *
 * ── なぜ抜き出したか ────────────────────────────────────
 * この 4 手順は `lib/photo/upload.ts`（清掃写真 / P1-11）と
 * `lib/photo/inspectionUpload.ts`（検査写真 / P2-04）に**同じ形で 2 回**
 * 書かれていた。P2-13 が忘れ物と不具合の 2 経路を足すと 4 回になる。
 * **順序を間違えた 1 か所が静かに壊れる**（EXIF を落とす前にハッシュを
 * 取ると、R2 の実体と DB の値が食い違い、§6.3 の照合が常に失敗する）。
 * 手順そのものを 1 か所に固定し、経路ごとに違う部分だけを外に置く。
 *
 * ── ここに置かないもの ──────────────────────────────────
 * **親の行を引くこと・権限判定・DB への INSERT はここに無い。**
 * それらは経路ごとに違う（タスク / 検査 / 忘れ物 / 不具合）。
 * 呼び出し側が「引いて、判定して、この関数を呼んで、INSERT する」。
 * ここへ `assertPermission()` を持ち込むと、どのアクションで判定するかを
 * 引数で受けることになり、**渡し間違いが権限の穴になる。**
 *
 * ── 再送の判定もここに無い ──────────────────────────────
 * `clientId` の照合は表ごとに違う関数を引く（`findTaskPhotoByClientId()` /
 * `findInspectionPhotoByClientId()` …）。**R2 へ触る前に呼び出し側が済ませる。**
 */

import { MAX_PHOTO_BYTES, type PhotoErrorCode } from "@pk/contracts";
import type { Env } from "@pk/db";

import { sha256Hex } from "../evidence/hash.js";

import { sanitizeImage } from "./image.js";

/** R2 へ置いた 1 枚。**呼び出し側はこれを DB へ書く。** */
export interface StoredPhoto {
  storageKey: string;
  /** **EXIF を落としたあとの**バイト列のハッシュ（§6.3）。 */
  sha256: string;
  width: number;
  height: number;
  fileSize: number;
  /** `image/jpeg` か `image/png`。キーの拡張子を決めるのに使う。 */
  format: string;
}

export type StorePhotoOutcome =
  | { kind: "OK"; photo: StoredPhoto }
  | { kind: "REJECTED"; error: PhotoErrorCode };

/**
 * 写真を R2 へ置くまで。
 *
 * @param storageKeyOf 拡張子を受け取ってキーを返す。**キーの形は経路ごとに
 *   違う**（`photos/{orgId}/{propertyId}/{businessDate}/{taskId}/{photoId}.jpg`）
 *   が、どれも組織 ID から始まる（security.md §4 / `isOwnPhotoKey()`）。
 */
export async function storePhoto(
  env: Env,
  bytes: Uint8Array,
  storageKeyOf: (extension: "jpg" | "png") => string,
): Promise<StorePhotoOutcome> {
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    return { kind: "REJECTED", error: "PHOTO_TOO_LARGE" };
  }

  // **ここで位置情報が落ちる**（INV-11）。落とせない形式は受け付けない。
  // この行より後でしかハッシュを取らないこと（冒頭の注記）。
  const sanitized = sanitizeImage(bytes);
  if (sanitized === null) return { kind: "REJECTED", error: "UNSUPPORTED_IMAGE" };

  const storageKey = storageKeyOf(sanitized.format === "image/png" ? "png" : "jpg");
  const sha256 = await sha256Hex(sanitized.bytes);

  await env.PHOTOS.put(storageKey, sanitized.bytes, {
    httpMetadata: { contentType: sanitized.format },
    // **R2 側にも残す**（§6.3「DB の sha256 と R2 object metadata の双方へ保存」）。
    // 照合そのものは実体から取り直す（`lib/evidence/photoIntegrity.ts`）ので、
    // ここは調査のときに R2 だけ見て突き合わせられるようにするための控え。
    customMetadata: { sha256 },
  });

  return {
    kind: "OK",
    photo: {
      storageKey,
      sha256,
      width: sanitized.size.width,
      height: sanitized.size.height,
      fileSize: sanitized.bytes.byteLength,
      format: sanitized.format,
    },
  };
}
