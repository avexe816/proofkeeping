/**
 * 検査 API の入出力（PK-SPEC-P2 §4.2〜§4.5 / §14.1）。
 *
 * task: docs/tasks/P2-04.md
 *
 * ── 受け取らない値 ──────────────────────────────────────
 * `organizationId` はどのスキーマにも無い（セッションから解決する）。
 * **`result`（検査全体の判定）も無い。** 全体は項目の集約で決まり、
 * 検査者が上書きできない（§4.3 MUST）。ボディに口を作ると、画面から
 * 「全て合格」を消しても API 経由で同じことができてしまう。
 * `round` も受け取らない。`cleaningTask.currentInspectionRound + 1`（§4.2）。
 *
 * ── 項目の更新は 1 件ずつ ────────────────────────────────
 * §14.1 の経路名は `PUT /inspections/:id/items`（複数形）だが、
 * **ボディは 1 項目**にしてある。配列を受ける口があると「全項目 PASS」を
 * 1 リクエストで送れてしまい、P2 固有の絶対ルール（全 PASS 初期化の禁止・
 * 「全て合格」ボタンの禁止）が API 側から素通りになる。
 * P1-06 のチェックリスト（§6.3）と同じ判断（DECISIONS #064）。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙
// ────────────────────────────────────────────────────────────

/** 検査全体の判定（§3.1 の `InspectionResult`）。 */
export const INSPECTION_RESULTS = ["PASS", "FAIL"] as const;

export const inspectionResultSchema = z.enum(INSPECTION_RESULTS);

export type InspectionResultValue = (typeof INSPECTION_RESULTS)[number];

/** 項目 1 件の判定（§4.3 の「合格 / 不合格 / 対象外」）。 */
export const INSPECTION_ITEM_STATUSES = ["PASS", "FAIL", "NOT_APPLICABLE"] as const;

export const inspectionItemStatusSchema = z.enum(INSPECTION_ITEM_STATUSES);

export type InspectionItemStatusValue = (typeof INSPECTION_ITEM_STATUSES)[number];

/** 不合格の理由コード（§3.3 の `DefectCode`）。`packages/db` と同じ並び。 */
export const DEFECT_CODES = [
  "DUST",
  "HAIR",
  "STAIN",
  "ODOR",
  "WATER_SPOT",
  "MISSING_AMENITY",
  "LINEN_WRINKLE",
  "BED_MAKING",
  "TRASH_REMAINING",
  "EQUIPMENT_NOT_RESET",
  "DAMAGE",
  "OTHER",
] as const;

export const defectCodeSchema = z.enum(DEFECT_CODES);

export type DefectCodeValue = (typeof DEFECT_CODES)[number];

/** 不合格コメントの長さ（§4.3「コメント 1〜200 文字」）。 */
export const DEFECT_NOTE_MAX_LENGTH = 200;

/** 自己検査の理由・全体所見の長さ。**下限は 1 文字**（空文字を通さない）。 */
export const OVERRIDE_REASON_MAX_LENGTH = 200;
export const GENERAL_NOTE_MAX_LENGTH = 500;

// ────────────────────────────────────────────────────────────
// エラー
// ────────────────────────────────────────────────────────────

/**
 * 検査 API 固有のエラーコード。
 *
 * **403 相当を足さないこと**（INV-31）。権限・担当外施設・別テナントは
 * middleware が 404 に潰す。ここに載るのは「その操作が今の状態では
 * 成立しない」ことだけ。
 */
export const INSPECTION_ERROR_CODES = [
  "INVALID_REQUEST",
  /** §4.2。別の検査者が既に開始している。 */
  "INSPECTION_ALREADY_STARTED",
  /** 既に完了した検査への操作。 */
  "INSPECTION_ALREADY_COMPLETED",
  /** 検査待ちでないタスクを検査しようとした（§4.1 の状態遷移）。 */
  "INVALID_TRANSITION",
  /** 清掃担当者本人による検査。**施設が許していない**（§4.2 / security.md §1）。 */
  "SELF_INSPECTION_FORBIDDEN",
  /** 自己検査の例外に理由が無い（§4.2）。 */
  "REASON_REQUIRED",
  /** 答えていない項目がある（§4.3）。 */
  "ITEMS_INCOMPLETE",
  /** FAIL に理由コード・コメント・写真のいずれかが無い（§4.3）。 */
  "DEFECT_DETAILS_REQUIRED",
] as const;

export type InspectionErrorCode = (typeof INSPECTION_ERROR_CODES)[number];

/**
 * エラー応答。**何が足りないかを項目 ID で返す。**
 *
 * 文言を載せない。画面が i18n キーへ写す（ui-writing.md §1・§2）。
 */
export const inspectionErrorSchema = z.object({
  error: z.enum(INSPECTION_ERROR_CODES),
  details: z
    .object({
      unansweredItemIds: z.array(z.string()).optional(),
      missingDefectCodeItemIds: z.array(z.string()).optional(),
      missingNoteItemIds: z.array(z.string()).optional(),
      missingPhotoItemIds: z.array(z.string()).optional(),
    })
    .optional(),
});

export type InspectionError = z.infer<typeof inspectionErrorSchema>;

// ────────────────────────────────────────────────────────────
// 検査開始（§4.2）
// ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/tasks/:taskId/inspection/start`。
 *
 * `overrideReason` は自己検査の例外（§4.2）にだけ使う。**他人のタスクを
 * 検査するときは送らない**（送られても記録しない）。
 */
export const inspectionStartRequestSchema = z.object({
  overrideReason: z.string().min(1).max(OVERRIDE_REASON_MAX_LENGTH).optional(),
  /** 端末側の時刻。**参考値**（サーバー時刻が正）。 */
  clientTs: z.number().int().optional(),
});

export type InspectionStartRequest = z.infer<typeof inspectionStartRequestSchema>;

// ────────────────────────────────────────────────────────────
// 検査項目（§4.3）
// ────────────────────────────────────────────────────────────

/**
 * `PUT /api/v1/inspections/:inspectionId/items`。**1 項目ずつ。**
 *
 * `status` に既定値を置かない（未選択から始まる / P2 固有の絶対ルール）。
 * FAIL に要るもの（理由コード・コメント・写真）の検査は
 * **完了時に行う**（`packages/engine` の `checkInspectionCompletion()`）。
 * 入力の途中で弾くと、写真を撮る前に不合格を選べなくなる。
 */
export const inspectionItemUpdateRequestSchema = z.object({
  checklistItemId: resourceIdSchema,
  status: inspectionItemStatusSchema,
  defectCode: defectCodeSchema.optional(),
  note: z.string().max(DEFECT_NOTE_MAX_LENGTH).optional(),
  /** 再清掃の要否（§4.3）。既定は「不合格なら要る」を画面が立てる。 */
  reworkRequired: z.boolean().optional(),
});

export type InspectionItemUpdateRequest = z.infer<typeof inspectionItemUpdateRequestSchema>;

/** 検査画面に出す項目 1 件。 */
export const inspectionItemSchema = z.object({
  checklistItemId: z.string(),
  section: z.string(),
  labels: z.record(z.string(), z.string()),
  /** **未選択は `null`。** 既定値を持たせない（§4.3）。 */
  status: inspectionItemStatusSchema.nullable(),
  defectCode: defectCodeSchema.nullable(),
  note: z.string().nullable(),
  reworkRequired: z.boolean(),
  photoCount: z.number().int().min(0),
  /** 清掃時の記録（`taskChecklistResult.value`）。検査者が突き合わせる。 */
  cleaningValue: z.string().nullable(),
  sortOrder: z.number().int(),
});

export type InspectionItem = z.infer<typeof inspectionItemSchema>;

// ────────────────────────────────────────────────────────────
// 検査の応答
// ────────────────────────────────────────────────────────────

/** 検査 1 件。**全体の判定は完了までは `null`。** */
export const inspectionSchema = z.object({
  inspectionId: z.string(),
  taskId: z.string(),
  propertyId: z.string(),
  roomNumber: z.string(),
  businessDate: businessDateSchema,
  round: z.number().int().min(1),
  inspectorId: z.string(),
  result: inspectionResultSchema.nullable(),
  startedAt: z.number().int(),
  completedAt: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  selfApproved: z.boolean(),
  generalNote: z.string().nullable(),
});

export type Inspection = z.infer<typeof inspectionSchema>;

/** 検査詳細（M-09 が読む）。**項目を必ず添える。** */
export const inspectionDetailResponseSchema = z.object({
  data: inspectionSchema,
  items: z.array(inspectionItemSchema),
  /** 再送で既に開始済みだった（§4.2 の同一検査者による再要求）。 */
  unchanged: z.boolean().optional(),
});

export type InspectionDetailResponse = z.infer<typeof inspectionDetailResponseSchema>;

// ────────────────────────────────────────────────────────────
// 検査完了（§4.4 / §4.5）
// ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/inspections/:inspectionId/complete`。
 *
 * **判定を受け取らない。** 項目の集約で決まる（§4.3 MUST）。
 */
export const inspectionCompleteRequestSchema = z.object({
  generalNote: z.string().max(GENERAL_NOTE_MAX_LENGTH).optional(),
  clientTs: z.number().int().optional(),
});

export type InspectionCompleteRequest = z.infer<typeof inspectionCompleteRequestSchema>;

/** 完了の応答。差戻しなら `reworkCycleId` が付く（§4.5）。 */
export const inspectionCompleteResponseSchema = z.object({
  data: inspectionSchema,
  result: inspectionResultSchema,
  /** 更新後のタスクの状態（`COMPLETED` / `REWORK`）。 */
  taskStatus: z.string(),
  reworkCycleId: z.string().nullable(),
  unchanged: z.boolean(),
});

export type InspectionCompleteResponse = z.infer<typeof inspectionCompleteResponseSchema>;

// ────────────────────────────────────────────────────────────
// 検査写真（§4.3 / §6.5）
// ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/inspections/:inspectionId/photos`（`multipart/form-data`）。
 *
 * 清掃写真（`taskPhoto`）と別の表・別の経路にしてある。証跡 ZIP が
 * `cleaning-*` と `inspection-*` に分かれる（§6.5）ため。
 */
export const inspectionPhotoUploadMetaSchema = z.object({
  /** 端末で採番した uuid。**冪等鍵。** */
  clientId: z.string().min(1).max(64),
  /** どの項目の不合格に対する写真か（`inspectionItemResult.id`）。 */
  itemResultId: resourceIdSchema,
});

export type InspectionPhotoUploadMeta = z.infer<typeof inspectionPhotoUploadMetaSchema>;

/** 検査写真 1 枚。**`storageKey` を返さない。** */
export const inspectionPhotoSchema = z.object({
  photoId: z.string(),
  inspectionId: z.string(),
  itemResultId: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  fileSize: z.number().int(),
  /** アップロード時にサーバーが計算した SHA-256（§6.3）。 */
  sha256: z.string(),
  uploadedAt: z.number().int(),
  /** 15 分有効の署名付き URL（security.md §4）。 */
  url: z.string(),
});

export type InspectionPhoto = z.infer<typeof inspectionPhotoSchema>;

export const inspectionPhotoUploadResponseSchema = z.object({
  data: inspectionPhotoSchema,
  unchanged: z.boolean(),
});

export type InspectionPhotoUploadResponse = z.infer<typeof inspectionPhotoUploadResponseSchema>;
