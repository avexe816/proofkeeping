/**
 * 観察記録・リネン記録・観察設定 API の入出力（PK-SPEC-P3 §2・§4・§7）。
 *
 * task: docs/tasks/P3-03.md / P3-04.md / P3-05.md / P3-06.md / P3-07.md / P3-11.md
 *
 * ── 受け取らないもの ────────────────────────────────────
 * **「判断」を表す欄が 1 つも無い**（§1.1）。「使われましたか」「不審な点」
 * 「異常」に当たる入力を作らない。清掃員が送るのは目で見た数と段階だけで、
 * 閾値との突き合わせは P4 が行う（§0.2「P3 は差異検出をしない」）。
 *
 * **`organizationId` / `propertyId` / `roomId` / `businessDate` を受け取らない。**
 * すべてタスクから解決する（CLAUDE.md §4 / INV-32）。
 *
 * **宿泊者に関する欄が 1 つも無い**（security.md §3）。人数すら受け取らない
 * （既定値の推定に使う `guestCount` は `dailyRoomPlan` 側の値）。
 *
 * ── 上限値の考え方 ──────────────────────────────────────
 * 個数は 0〜`MAX_OBSERVED_QTY`。**上限は誤入力を弾くためのもので、
 * 業務上の制限ではない。** ステッパーの連打で 3 桁が入ると
 * ベースラインの外れ値除外（§5.3）が毎回そこを拾うことになる。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙（§2.1 / §2.5）
// ────────────────────────────────────────────────────────────

/** ゴミの量（§2.1）。`packages/db` の `TRASH_LEVELS` と同じ並び。 */
export const TRASH_LEVELS = ["NONE", "LOW", "NORMAL", "HIGH"] as const;

export const trashLevelSchema = z.enum(TRASH_LEVELS);

export type TrashLevelValue = (typeof TRASH_LEVELS)[number];

/** リネンの品目コード（§2.5）。`packages/db` の `LINEN_ITEM_CODES` と同じ並び。 */
export const LINEN_ITEM_CODES = [
  "SHEET_SINGLE",
  "SHEET_DOUBLE",
  "DUVET_COVER",
  "PILLOW_CASE",
  "BATH_TOWEL",
  "FACE_TOWEL",
  "HAND_TOWEL",
  "BATH_MAT",
  "YUKATA",
  // 追加布団（DECISIONS #252）。値は roomObservation.extra_futon_used 列。
  "EXTRA_FUTON",
] as const;

/** アメニティの品目コード（§2.5）。 */
export const AMENITY_ITEM_CODES = [
  "TOOTHBRUSH",
  "RAZOR",
  "SHAMPOO",
  "CONDITIONER",
  "BODY_SOAP",
  "HAIR_BRUSH",
  "COTTON_SET",
  "SLIPPERS",
  "BOTTLED_WATER",
  "TEA_BAG",
  // コップ（DECISIONS #252）。値は roomObservation.cups_used 列。
  "CUP",
] as const;

/** 品目コード（§2.5）。**一度使ったコードを変えない。** */
export const ITEM_CODES = [...LINEN_ITEM_CODES, ...AMENITY_ITEM_CODES] as const;

export const itemCodeSchema = z.enum(ITEM_CODES);

export type ItemCodeValue = (typeof ITEM_CODES)[number];

/** 個数の上限。**誤入力の門番**（上のコメント）。 */
export const MAX_OBSERVED_QTY = 99;

/** 備考の長さ。 */
export const OBSERVATION_NOTE_MAX_LENGTH = 300;

/** 事後修正の理由（§2.2 MUST「理由必須」）。**下限 1 文字で空文字を弾く。** */
export const AMEND_REASON_MIN_LENGTH = 1;
export const AMEND_REASON_MAX_LENGTH = 300;

/** 0 以上 `MAX_OBSERVED_QTY` 以下の整数。 */
const qtySchema = z.number().int().min(0).max(MAX_OBSERVED_QTY);

// ────────────────────────────────────────────────────────────
// エラー
// ────────────────────────────────────────────────────────────

/**
 * 観察記録・リネン API 固有のエラーコード。
 *
 * **403 相当を足さないこと**（INV-31）。権限・担当外施設・別テナントは 404。
 */
export const OBSERVATION_ERROR_CODES = [
  "INVALID_REQUEST",
  /**
   * 破損・汚損の報告に写真が無い（§4.3 MUST）。
   *
   * **409 にしない。** オフラインキューは 409 を成功として捨てる
   * （ui-writing.md §5 / `lib/offline/policy.ts`）。写真が届くより先に
   * リネン記録が届いた場合、409 を返すと**記録が消える**（P3-05 の
   * 完了条件「記録が失われない」）。400 なら赤バッジで手元に残る。
   */
  "PHOTO_REQUIRED",
  /** 事後修正に理由が無い（§2.2 MUST）。 */
  "REASON_REQUIRED",
  /** 施設の設定で観察記録が無効（§2.6 の `enabled = false`）。 */
  "OBSERVATION_DISABLED",
] as const;

export type ObservationErrorCode = (typeof OBSERVATION_ERROR_CODES)[number];

/** エラー応答。**文言を載せない。** 画面が i18n キーへ写す。 */
export const observationErrorSchema = z.object({
  error: z.enum(OBSERVATION_ERROR_CODES),
});

export type ObservationError = z.infer<typeof observationErrorSchema>;

// ────────────────────────────────────────────────────────────
// 観察記録（§2.1 / §4.1 / §4.2）
// ────────────────────────────────────────────────────────────

/**
 * 入室時に数える項目（§4.1 / §4.2）。
 *
 * **7 つより多く見えるが、画面に一度に出るのは 7 つまで**（§1.2 MUST）。
 * M-05 が出すのはベッド・ゴミ・バスタオル・フェイス・バスマットの 5 つで、
 * 残り（ハンドタオル・スリッパ・グラス・追加布団・アメニティ）は
 * M-05b の任意入力（§4.2）。**画面の分割で満たしている。**
 */
export const observationCountsSchema = z.object({
  bedsUsed: qtySchema,
  trashLevel: trashLevelSchema,
  bathTowelUsed: qtySchema,
  faceTowelUsed: qtySchema,
  handTowelUsed: qtySchema,
  bathMatUsed: qtySchema,
  slippersUsed: qtySchema,
  cupsUsed: qtySchema,
  extraFutonUsed: qtySchema,
  /**
   * 品目コード → 個数、または使用の有無（§2.1）。
   *
   * **`boolean` も受けるのは §12.4 が未決だから。** 「使用あり／なし」と
   * 「個数」のどちらを既定にするかは品目により異なるとされ、決着していない。
   * 現在の画面（M-05b）は全品目をステッパー（数値）で出す
   * （docs/OPEN_QUESTIONS.md #059）。型を先に広く取っておけば、
   * 決まったときに保存済みの行を読み替えずに済む。
   *
   * **鍵を `itemCodeSchema` にしていない。** enum を鍵にすると全 19 品目が
   * 必須になり、施設が有効にしていない品目まで送らせることになる
   * （§2.5 MUST に反する）。語彙に無い鍵は保存前に落ちる
   * （`lib/observation/record.ts` の `filterAmenities()`）。
   */
  amenitiesUsed: z.record(z.string().max(40), z.union([qtySchema, z.boolean()])),
});

export type ObservationCounts = z.infer<typeof observationCountsSchema>;

/**
 * `PUT /api/v1/tasks/:taskId/observation`（§7）。
 *
 * **冪等。** `Idempotency-Key` ヘッダで再送を弾く（§7 MUST）。上書きは許すが、
 * 旧値は `observationRevision` に残る（§2.2）。
 */
export const observationUpsertRequestSchema = observationCountsSchema.extend({
  note: z.string().max(OBSERVATION_NOTE_MAX_LENGTH).optional(),
  /**
   * 画面表示から確定までの実測ミリ秒（§4.1）。
   *
   * **個人の評価に使わない**（security.md §5）。出荷判定（§0.3 の中央値
   * 20 秒以内）と、3 秒未満の確定を外れ値として落とす判断（§5.3）に使う。
   */
  inputDurationMs: z.number().int().min(0).optional(),
  /** 既定値のまま確定したか（§3.3 MUST）。施設単位の警告に使う。 */
  usedDefaults: z.boolean(),
  /** 端末側の時刻。**参考値**（サーバー時刻が正）。 */
  clientTs: z.number().int().optional(),
});

export type ObservationUpsertRequest = z.infer<typeof observationUpsertRequestSchema>;

/**
 * `POST /api/v1/tasks/:taskId/observation/skip`（§7）。
 *
 * **理由を受け取らない**（§1.3 MUST「理由の選択も求めない」）。
 * 記録しなかったこと自体だけを `observationSkipped` に残す。
 */
export const observationSkipRequestSchema = z.object({
  clientTs: z.number().int().optional(),
});

export type ObservationSkipRequest = z.infer<typeof observationSkipRequestSchema>;

/**
 * `PATCH /api/v1/observations/:observationId`（§7 / §2.2）。
 *
 * **`PROPERTY_MANAGER` 以上・理由必須。** 旧値は `observationRevision` に残る。
 * `usedDefaults` / `inputDurationMs` を受け取らないのは、**それが
 * 「現場が入力したときの事実」だから。** 後から書き換えると W-22 の
 * 入力品質（§6.3）が意味を失う。
 */
export const observationAmendRequestSchema = observationCountsSchema.extend({
  note: z.string().max(OBSERVATION_NOTE_MAX_LENGTH).optional(),
  reason: z.string().min(AMEND_REASON_MIN_LENGTH).max(AMEND_REASON_MAX_LENGTH),
});

export type ObservationAmendRequest = z.infer<typeof observationAmendRequestSchema>;

/** 観察記録 1 件。 */
export const observationSchema = observationCountsSchema.extend({
  observationId: z.string(),
  taskId: z.string(),
  propertyId: z.string(),
  roomId: z.string(),
  roomTypeId: z.string(),
  businessDate: businessDateSchema,
  note: z.string().nullable(),
  inputDurationMs: z.number().int().nullable(),
  usedDefaults: z.boolean(),
  recordedAt: z.number().int(),
  /**
   * 事後修正の回数（§2.2）。0 なら未修正。
   *
   * **修正者の氏名を返さない。** 誰が直したかは監査ログ（`observation.amended`）に
   * 残る。画面に出すと、記録そのものではなく人への反応になる。
   */
  revisionCount: z.number().int().min(0),
});

export type Observation = z.infer<typeof observationSchema>;

/**
 * 施設の観察設定（§2.6）。**画面に何を出すかを決める。**
 *
 * `require*` は「入力画面に出すか」であって、入力を強制する意味ではない
 * （§1.3。「今回は記録しない」は常に出る）。
 */
export const observationConfigSchema = z.object({
  propertyId: z.string(),
  enabled: z.boolean(),
  requireBeds: z.boolean(),
  requireTrash: z.boolean(),
  requireTowels: z.boolean(),
  requireAmenities: z.boolean(),
  requireLinen: z.boolean(),
  /** 有効な品目コード（§2.5 MUST）。**ここに無い品目を画面に出さない。** */
  enabledItemCodes: z.array(itemCodeSchema),
  skipWarnThreshold: z.number().int().min(0).max(100),
});

export type ObservationConfig = z.infer<typeof observationConfigSchema>;

/**
 * `GET /api/v1/tasks/:taskId/observation`（§7）。
 *
 * ── 既定値と設定を同梱する ──────────────────────────────
 * M-05 は `start` の直後に全画面で出る（§3.2）。**そこで往復を増やさない。**
 * 既定値（§3.3）は `dailyRoomPlan` と `roomType` から、表示する項目は
 * `observationConfig` から決まる。3 回引かせると、電波の悪い客室で
 * 画面が出るまでに時間が掛かる（docs/DECISIONS.md #097）。
 */
export const observationDetailResponseSchema = z.object({
  /** 未記録なら `null`。 */
  data: observationSchema.nullable(),
  /** 既定値（§3.3）。**記録済みでも返す**（M-05b が差分を出せるように）。 */
  defaults: observationCountsSchema,
  config: observationConfigSchema,
  /** 「今回は記録しない」が押されているか（§1.3）。 */
  skipped: z.boolean(),
});

export type ObservationDetailResponse = z.infer<typeof observationDetailResponseSchema>;

/** 記録・スキップ・事後修正の応答。 */
export const observationUpsertResponseSchema = z.object({
  data: observationSchema.nullable(),
  /** 再送で既に記録済みだった（オフラインキューは 409 と同じく成功として扱う）。 */
  unchanged: z.boolean(),
});

export type ObservationUpsertResponse = z.infer<typeof observationUpsertResponseSchema>;

/** `GET /api/v1/observations?propertyId=&from=&to=`（§7 / W-19）。 */
export const observationListResponseSchema = z.object({
  data: z.array(observationSchema),
});

export type ObservationListResponse = z.infer<typeof observationListResponseSchema>;

// ────────────────────────────────────────────────────────────
// リネン記録（§2.3 / §4.3）
// ────────────────────────────────────────────────────────────

/**
 * 品目 1 件ぶんの枚数（§2.3）。
 *
 * **枚数であって金額ではない**（§1.4）。単価・弁償額の欄を足さないこと。
 * 在庫と原価は P5 以降の範囲。
 */
export const linenEntrySchema = z.object({
  itemCode: itemCodeSchema,
  collectedQty: qtySchema,
  suppliedQty: qtySchema,
  damagedQty: qtySchema,
  stainedQty: qtySchema,
  note: z.string().max(OBSERVATION_NOTE_MAX_LENGTH).optional(),
});

export type LinenEntry = z.infer<typeof linenEntrySchema>;

/**
 * `PUT /api/v1/tasks/:taskId/linen`（§7）。**配列で一括。**
 *
 * 観察記録（1 タスク 1 行）と違い、リネンは品目ごとに 1 行になる
 * （`uq_linen (organizationId, taskId, itemCode)`）。**画面 1 回の操作で
 * 全品目が確定する**ので、まとめて受ける口にしてある。
 * 一括で受けても「すべてチェック」には当たらない（値は品目ごとに違う）。
 */
export const linenUpsertRequestSchema = z.object({
  entries: z.array(linenEntrySchema).max(ITEM_CODES.length),
  clientTs: z.number().int().optional(),
});

export type LinenUpsertRequest = z.infer<typeof linenUpsertRequestSchema>;

/** リネン記録 1 件。 */
export const linenRecordSchema = linenEntrySchema.extend({
  linenRecordId: z.string(),
  taskId: z.string(),
  businessDate: businessDateSchema,
  note: z.string().nullable(),
  recordedAt: z.number().int(),
});

export type LinenRecordSummary = z.infer<typeof linenRecordSchema>;

/** `GET /api/v1/tasks/:taskId/linen` と `PUT` の応答。 */
export const linenListResponseSchema = z.object({
  taskId: z.string(),
  data: z.array(linenRecordSchema),
  /** 画面に出す品目（§2.5 MUST の有効・無効を適用済み）。 */
  enabledItemCodes: z.array(itemCodeSchema),
  /** 施設設定で退室前のリネン記録を出すか（§4.3）。 */
  requireLinen: z.boolean(),
});

export type LinenListResponse = z.infer<typeof linenListResponseSchema>;

// ────────────────────────────────────────────────────────────
// 観察項目の設定（W-20 / §2.6）
// ────────────────────────────────────────────────────────────

/**
 * W-20 の保存。
 *
 * **`propertyId` を本体で受け取らない。** 対象は表示中の施設で、
 * 画面の action がセッションから解決する（INV-32）。
 */
export const observationConfigUpdateRequestSchema = z.object({
  enabled: z.boolean(),
  requireBeds: z.boolean(),
  requireTrash: z.boolean(),
  requireTowels: z.boolean(),
  requireAmenities: z.boolean(),
  requireLinen: z.boolean(),
  enabledItemCodes: z.array(itemCodeSchema),
  skipWarnThreshold: z.number().int().min(0).max(100),
});

export type ObservationConfigUpdateRequest = z.infer<typeof observationConfigUpdateRequestSchema>;

/** 施設 ID の形式検査だけを掛けたい場面（W-19 の一覧など）で使う。 */
export const observationPropertyIdSchema = resourceIdSchema;
