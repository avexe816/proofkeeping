/**
 * 清掃写真の API 入出力（PK-SPEC-P1 §7）。
 *
 * task:  docs/tasks/P1-11.md
 * ルール: .claude/rules/security.md §4
 *
 * ── 本体は multipart で受ける ───────────────────────────
 * 画像を base64 で JSON に載せると 4/3 に膨らむ。現場は電波の悪い建物内で
 * 送るので、増えた分がそのまま失敗率に乗る。**`multipart/form-data` の
 * `file` フィールドで受け、添えるメタデータだけをここで検証する。**
 *
 * ── 位置情報の列がここに無いのは意図 ────────────────────
 * `latitude` / `longitude` / `gps` を持つスキーマを作らない（INV-11）。
 * 受け口が無ければ、後から「せっかく送られてくるので保存する」が起きない。
 */

import { z } from "zod";

import { resourceIdSchema } from "./task.js";

/** 写真の種別（`packages/db` の `PHOTO_KINDS` と同じ語彙）。 */
export const PHOTO_KINDS = ["BEFORE", "AFTER", "CHECKLIST", "OTHER"] as const;

export const photoKindSchema = z.enum(PHOTO_KINDS);

export type PhotoKindValue = (typeof PHOTO_KINDS)[number];

/** 1 タスクあたりの上限（§7.3）。 */
export const MAX_PHOTOS_PER_TASK = 20;

/** リサイズ後の 1 枚の上限（§7.3）。**サーバー側でも確かめる。** */
export const MAX_PHOTO_BYTES = 500 * 1024;

/** クライアントでのリサイズ目標（§7.2）。長辺 1600px・JPEG quality 0.7。 */
export const PHOTO_MAX_LONG_EDGE = 1600;
export const PHOTO_JPEG_QUALITY = 0.7;

/**
 * サーバーが受け付ける MIME。
 *
 * §7.3 は `image/heic` も挙げるが、**それは撮影時に端末が出す形式のこと。**
 * クライアントは canvas で再エンコードしてから送る（HEIC → JPEG）ので、
 * ここへ HEIC が届く経路は無い。Workers に HEIC のデコーダは無く、
 * 受け付けても EXIF を落とせないまま保存することになる。**受けない。**
 */
export const ACCEPTED_PHOTO_MIME = ["image/jpeg", "image/png"] as const;

export type AcceptedPhotoMime = (typeof ACCEPTED_PHOTO_MIME)[number];

/**
 * アップロードに添えるメタデータ（multipart のテキスト部）。
 *
 * `capturedAt` を受け取らない。撮影時刻は**サーバー時刻で上書きする**
 * （PK-IMPL-CONTRACT §2.5）。端末の時計は現場でずれており、
 * オフラインで溜めた写真の順序を端末時刻で決めると証跡の並びが崩れる。
 */
export const photoUploadMetaSchema = z.object({
  /** 端末で採番する uuid。**再送の冪等鍵**（§7.5）。 */
  clientId: z.uuid(),
  kind: photoKindSchema.default("AFTER"),
  /** 写真必須のチェックリスト項目に紐づける場合のみ。 */
  checklistItemId: resourceIdSchema.optional(),
});

export type PhotoUploadMeta = z.infer<typeof photoUploadMetaSchema>;

/** 応答の 1 件。**R2 のキーをそのまま返さない**（組織 ID が読める）。 */
export const taskPhotoSchema = z.object({
  photoId: z.string(),
  taskId: z.string(),
  kind: photoKindSchema,
  checklistItemId: z.string().nullable(),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  fileSize: z.number().int().min(0),
  /** サーバー時刻（epoch ミリ秒）。 */
  capturedAt: z.number().int().nullable(),
  uploadedAt: z.number().int(),
  /** 15 分有効の署名付き URL（security.md §4）。 */
  url: z.string(),
});

export type TaskPhoto = z.infer<typeof taskPhotoSchema>;

/** `GET /api/v1/tasks/{id}/photos`。 */
export const taskPhotoListResponseSchema = z.object({
  taskId: z.string(),
  count: z.number().int().min(0),
  limit: z.number().int().min(1),
  data: z.array(taskPhotoSchema),
});

export type TaskPhotoListResponse = z.infer<typeof taskPhotoListResponseSchema>;

/** `POST /api/v1/tasks/{id}/photos`。**再送は `unchanged: true` で 200。** */
export const taskPhotoUploadResponseSchema = z.object({
  data: taskPhotoSchema,
  unchanged: z.boolean(),
});

export type TaskPhotoUploadResponse = z.infer<typeof taskPhotoUploadResponseSchema>;

/**
 * 写真固有のエラー。**403 相当を足さない**（INV-31）。
 *
 * `TASK_ERROR_CODES` へ混ぜていないのは、タスクの状態機械のエラーと
 * 受け取った画像のエラーが別の失敗単位だから。画面の出し分けも変わる
 * （前者はタスクの再取得、後者は撮り直し）。
 */
export const PHOTO_ERROR_CODES = [
  "INVALID_REQUEST",
  /** 1 タスク 20 枚（§7.3）。 */
  "PHOTO_LIMIT_EXCEEDED",
  /** リサイズ後 500KB 超（§7.3）。 */
  "PHOTO_TOO_LARGE",
  /** JPEG / PNG 以外、または画像として読めない。 */
  "UNSUPPORTED_IMAGE",
] as const;

export type PhotoErrorCode = (typeof PHOTO_ERROR_CODES)[number];

export const photoErrorSchema = z.object({ error: z.enum(PHOTO_ERROR_CODES) });

export type PhotoError = z.infer<typeof photoErrorSchema>;
