/**
 * 稼働記録 API の入出力（PK-SPEC-P4 §2.1・§8）。
 *
 * task: docs/tasks/P4-02.md
 *
 * ── 受け取らないもの ────────────────────────────────────
 * **宿泊者に関する欄が 1 つも無い**（§2.1 MUST / security.md §3）。
 * 氏名・連絡先・住所・パスポート・カードを表す欄を足さないこと。
 * 照合に要るのは人数（`guestCount`）と予約参照番号（`reservationRef`）だけ。
 *
 * **`organizationId` を受け取らない**（CLAUDE.md §4 / INV-32）。
 * セッションから解決する。`propertyId` は施設をまたぐ取込があるため受け取り、
 * `assertPermission()` が担当施設に絞る。
 *
 * ── `rawPayload` を受け取らない・返さない ────────────────
 * 外部の生データを API 越しに入れる口を作らない。マスクの責任が
 * クライアント側に移り、個人情報がそのまま保存される経路になる。
 * PMS 連携（P6）がアダプタの内側で入れる。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙（§2.1）
// ────────────────────────────────────────────────────────────

/** 取込元。`packages/db` の `OCCUPANCY_SOURCES` と同じ並び。 */
export const OCCUPANCY_SOURCES = ["PMS_API", "CSV_IMPORT", "MANUAL"] as const;

export const occupancySourceSchema = z.enum(OCCUPANCY_SOURCES);

export type OccupancySourceValue = (typeof OCCUPANCY_SOURCES)[number];

/** 販売経路。`packages/db` の `OCCUPANCY_CHANNEL_CODES` と同じ並び。 */
export const OCCUPANCY_CHANNEL_CODES = ["OTA", "DIRECT", "WALK_IN"] as const;

export const occupancyChannelCodeSchema = z.enum(OCCUPANCY_CHANNEL_CODES);

export type OccupancyChannelCodeValue = (typeof OCCUPANCY_CHANNEL_CODES)[number];

/** 人数の上限。**誤入力の門番**（業務上の制限ではない）。 */
export const MAX_GUEST_COUNT = 99;

/** 泊数の上限。1 年を超える予約は誤入力とみなす。 */
export const MAX_NIGHTS = 365;

/** 予約参照番号の長さ。 */
export const MAX_RESERVATION_REF_LENGTH = 64;

/** CSV 本文の上限。5,000 室 × 1 行でも収まる大きさ。 */
export const MAX_OCCUPANCY_CSV_LENGTH = 1_000_000;

// ────────────────────────────────────────────────────────────
// 入力
// ────────────────────────────────────────────────────────────

/**
 * 1 客室ぶんの稼働記録（`POST /api/v1/occupancy/snapshots` の 1 件）。
 *
 * **`source` は行ごとに持たない。** 1 回の呼び出しは 1 つの取込元。
 * 混ぜられると、どの取込元の記録を上書きしたのかが読めなくなる。
 */
export const occupancySnapshotEntrySchema = z.object({
  roomId: resourceIdSchema,
  isOccupied: z.boolean(),
  guestCount: z.number().int().min(0).max(MAX_GUEST_COUNT).default(0),
  adultCount: z.number().int().min(0).max(MAX_GUEST_COUNT).default(0),
  childCount: z.number().int().min(0).max(MAX_GUEST_COUNT).default(0),
  /** 予約番号のみ。**氏名を入れないこと**（§2.1 MUST）。 */
  reservationRef: z.string().max(MAX_RESERVATION_REF_LENGTH).nullable().default(null),
  channelCode: occupancyChannelCodeSchema.nullable().default(null),
  /** epoch ミリ秒。 */
  checkInAt: z.number().int().nullable().default(null),
  checkOutAt: z.number().int().nullable().default(null),
  isStayover: z.boolean().default(false),
  nightsTotal: z.number().int().min(1).max(MAX_NIGHTS).nullable().default(null),
  nightIndex: z.number().int().min(1).max(MAX_NIGHTS).nullable().default(null),
  ratePlanCode: z.string().max(64).nullable().default(null),
  isComplimentary: z.boolean().default(false),
  isHouseUse: z.boolean().default(false),
});

export type OccupancySnapshotEntry = z.infer<typeof occupancySnapshotEntrySchema>;

/**
 * `POST /api/v1/occupancy/snapshots`。手入力・PMS 以外からの登録。
 *
 * `source` は `MANUAL` のみ。**`PMS_API` を API 越しに名乗らせない。**
 * 連携が入れた記録と人が入れた記録の区別が付かなくなり、差異の説明が
 * できなくなる。`CSV_IMPORT` は `/import/csv` の口が付ける。
 */
export const occupancySnapshotUpsertRequestSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
  entries: z.array(occupancySnapshotEntrySchema).max(2000),
});

export type OccupancySnapshotUpsertRequest = z.infer<
  typeof occupancySnapshotUpsertRequestSchema
>;

/** `POST /api/v1/occupancy/import/csv`。CSV 取込（§8.1）。 */
export const occupancyImportRequestSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
  /** ヘッダ行を含む CSV 本文。列は §8.1 の 11 列。**未知の列は読まない。** */
  csv: z.string().max(MAX_OCCUPANCY_CSV_LENGTH),
});

export type OccupancyImportRequest = z.infer<typeof occupancyImportRequestSchema>;

// ────────────────────────────────────────────────────────────
// 出力
// ────────────────────────────────────────────────────────────

/**
 * 取込の結果。**取り込めなかった行を捨てずに返す**（`lib/plan/csv.ts` と同じ方針）。
 *
 * `unchanged` があるのは、再取込が「何も起きなかった」ことを画面で
 * 見せられるようにするため。0 件と区別が付かないと、取込が効いたのか
 * 効かなかったのかが分からない。
 */
export const occupancyImportResponseSchema = z.object({
  businessDate: businessDateSchema,
  source: occupancySourceSchema,
  inserted: z.number().int().min(0),
  updated: z.number().int().min(0),
  unchanged: z.number().int().min(0),
  /** 客室番号が客室マスタに無かった行。画面が一覧で示す。 */
  unknownRoomNumbers: z.array(z.string()),
  /** 取り込まなかった行の番号（1 始まり・ヘッダ行を含む）。 */
  skippedLines: z.array(z.number().int().min(1)),
});

export type OccupancyImportResponse = z.infer<typeof occupancyImportResponseSchema>;

/**
 * 稼働記録 1 件（`GET /api/v1/occupancy`）。
 *
 * **`rawPayload` を返さない**（外部の生データを外へ出さない）。
 */
export const occupancySnapshotSchema = z.object({
  id: resourceIdSchema,
  propertyId: resourceIdSchema,
  roomId: resourceIdSchema,
  businessDate: businessDateSchema,
  source: occupancySourceSchema,
  isOccupied: z.boolean(),
  guestCount: z.number().int().min(0),
  adultCount: z.number().int().min(0),
  childCount: z.number().int().min(0),
  reservationRef: z.string().nullable(),
  channelCode: occupancyChannelCodeSchema.nullable(),
  checkInAt: z.number().int().nullable(),
  checkOutAt: z.number().int().nullable(),
  isStayover: z.boolean(),
  nightsTotal: z.number().int().nullable(),
  nightIndex: z.number().int().nullable(),
  ratePlanCode: z.string().nullable(),
  isComplimentary: z.boolean(),
  isHouseUse: z.boolean(),
  importedAt: z.number().int(),
});

export type OccupancySnapshot = z.infer<typeof occupancySnapshotSchema>;

export const occupancyListResponseSchema = z.object({
  businessDate: businessDateSchema,
  data: z.array(occupancySnapshotSchema),
});

export type OccupancyListResponse = z.infer<typeof occupancyListResponseSchema>;

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
export const OCCUPANCY_ERROR_CODES = ["INVALID_REQUEST"] as const;

export const occupancyErrorSchema = z.object({
  error: z.enum(OCCUPANCY_ERROR_CODES),
});

export type OccupancyError = z.infer<typeof occupancyErrorSchema>;
