/**
 * 清掃タスクの API 入出力（PK-SPEC-P1 §3・§5・§6・§10.3）。
 *
 * task: docs/tasks/P1-02.md 〜 P1-06
 *
 * ── 受け取らない値 ──────────────────────────────────────
 * `organizationId` は**どのスキーマにも無い。** セッションから解決する
 * （CLAUDE.md §4 / PK-SPEC-P0 §19.4）。`propertyId` はパスやボディから
 * 受け取る口があるが、**それを権限判定の対象にしない**（INV-32）。
 * 資源から解決した施設で判定する。
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────
// 語彙
// ────────────────────────────────────────────────────────────

/** 清掃種別（§2.1）。`packages/db` の `TASK_TYPES` と同じ並び。 */
export const TASK_TYPES = ["CHECKOUT", "STAYOVER", "DEEP", "COMMON_AREA", "RECHECK"] as const;

export const taskTypeSchema = z.enum(TASK_TYPES);

export type TaskTypeValue = (typeof TASK_TYPES)[number];

/** タスクの状態（§2.1）。 */
export const TASK_STATUSES = [
  "CREATED",
  "ASSIGNED",
  "IN_PROGRESS",
  "PAUSED",
  "AWAITING_INSPECTION",
  "REWORK",
  "COMPLETED",
  "BLOCKED",
  "CANCELLED",
] as const;

export const taskStatusSchema = z.enum(TASK_STATUSES);

/** 状態変更の操作（§5.3 + 状態機械を閉じる 2 つ）。URL の末尾に載る。 */
export const TASK_ACTIONS = [
  "assign",
  "start",
  "pause",
  "resume",
  "complete",
  "block",
  "unblock",
  "cancel",
] as const;

export const taskActionSchema = z.enum(TASK_ACTIONS);

export type TaskActionValue = (typeof TASK_ACTIONS)[number];

/** チェックリストの 3 値（PK-IMPL-CONTRACT §2.4 / INV-22）。 */
export const CHECKLIST_VALUES = ["DONE", "COULD_NOT", "NOT_APPLICABLE"] as const;

export const checklistValueSchema = z.enum(CHECKLIST_VALUES);

/**
 * 中断・入室不可の理由コード（§9.3 / INV-24）。
 *
 * **`OTHER` を常設し、説明文を求めない**（INV-24）。自由記述を必須にすると
 * 現場が「その他」を選べなくなり、実態と違う理由が記録される。
 */
export const TASK_REASON_CODES = ["DND", "OCCUPIED", "LOCKED", "SUPPLY_SHORTAGE", "BREAK", "OTHER"] as const;

export const taskReasonCodeSchema = z.enum(TASK_REASON_CODES);

/** 業務日 `YYYY-MM-DD`（architecture.md §7）。 */
export const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 自己記述 ID（`{orgShortId}__{prefix}_{ulid}`）。形の検証だけを行う。 */
export const resourceIdSchema = z.string().regex(/^[0-9a-z]{6}__[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/);

// ────────────────────────────────────────────────────────────
// エラー
// ────────────────────────────────────────────────────────────

/**
 * タスク API 固有のエラーコード。
 *
 * **403 相当を足さないこと**（INV-31）。権限・担当外施設・別テナントは
 * すべて middleware が `RESOURCE_NOT_FOUND`（404）に潰す。
 * ここに載るのは「その操作が今の状態では成立しない」ことだけ。
 */
export const TASK_ERROR_CODES = [
  "INVALID_REQUEST",
  /** §5.3 MUST。未完了の必須項目がある。 */
  "CHECKLIST_INCOMPLETE",
  /** §5.3 MUST。写真必須の項目に写真が無い。 */
  "PHOTO_REQUIRED",
  /** その状態からは実行できない操作（§5.1 の状態機械）。 */
  "INVALID_TRANSITION",
  /** 中断・入室不可で理由コードが無い（§5.3）。 */
  "REASON_REQUIRED",
] as const;

export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

/**
 * エラー応答。`details` には**何が足りないか**を項目 ID で返す（§5.3 MUST）。
 *
 * 文言をここに載せない。画面が i18n キーへ写す（ui-writing.md §1）。
 * 「不備」「エラー」といった語を API 応答に出さないため（§5.1 の禁止語）でもある。
 */
export const taskErrorSchema = z.object({
  error: z.enum(TASK_ERROR_CODES),
  details: z
    .object({
      incompleteItemIds: z.array(z.string()).optional(),
      missingPhotoItemIds: z.array(z.string()).optional(),
    })
    .optional(),
});

export type TaskError = z.infer<typeof taskErrorSchema>;

// ────────────────────────────────────────────────────────────
// タスク一覧・状態変更（P1-05）
// ────────────────────────────────────────────────────────────

/** 一覧の 1 件。**シャード番号・組織 ID を含めない。** */
export const taskSummarySchema = z.object({
  taskId: z.string(),
  shortId: z.string(),
  propertyId: z.string(),
  roomId: z.string(),
  roomNumber: z.string(),
  roomTypeName: z.string().nullable(),
  businessDate: businessDateSchema,
  taskType: taskTypeSchema,
  status: taskStatusSchema,
  priority: z.number().int(),
  assigneeId: z.string().nullable(),
  standardMinutes: z.number().int().min(0),
  actualMinutes: z.number().int().min(0).nullable(),
  pauseCount: z.number().int().min(0),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  /**
   * チェックリストの進捗。分母は `NOT_APPLICABLE` を除く（§2.4）。
   *
   * **一覧では省く。** タスクごとに実施結果を引くと、100 件の一覧で
   * 100 クエリになり、§13 の「一覧 API は p95 < 300ms（100 件時）」を
   * 満たせない。進捗が要るのは詳細画面（M-03）で、そちらは
   * `/tasks/{id}/checklist` を引く。
   */
  checklistDone: z.number().int().min(0).optional(),
  checklistTotal: z.number().int().min(0).optional(),
});

export type TaskSummary = z.infer<typeof taskSummarySchema>;

/** `GET /api/v1/tasks` の応答。 */
export const taskListResponseSchema = z.object({
  businessDate: businessDateSchema,
  data: z.array(taskSummarySchema),
});

export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

/**
 * 状態変更の入力。**操作は URL 側（`/tasks/{id}/start`）で表す。**
 *
 * `clientTs` は端末側の時刻。**参考値**として保存するだけで、集計には
 * サーバー時刻を使う（PK-IMPL-CONTRACT §2.5 の「サーバー時刻で上書き」）。
 */
export const taskTransitionRequestSchema = z.object({
  /** `pause` / `block` で必須（§5.3）。 */
  reasonCode: taskReasonCodeSchema.optional(),
  /** `assign` で必須。`membership.id`。 */
  assigneeId: resourceIdSchema.optional(),
  /** オフライン時の端末時刻（epoch ミリ秒）。 */
  clientTs: z.number().int().positive().optional(),
  note: z.string().trim().max(500).optional(),
});

export type TaskTransitionRequest = z.infer<typeof taskTransitionRequestSchema>;

/** 状態変更の応答。**変更後の状態をそのまま返す**（楽観的更新の突き合わせ用）。 */
export const taskTransitionResponseSchema = z.object({
  data: taskSummarySchema,
  /** 再送で状態が変わらなかった場合 `true`（§8.2 の 409 相当を 200 で表す）。 */
  unchanged: z.boolean(),
});

export type TaskTransitionResponse = z.infer<typeof taskTransitionResponseSchema>;

// ────────────────────────────────────────────────────────────
// タスク生成（P1-03）
// ────────────────────────────────────────────────────────────

/** `POST /api/v1/tasks/generate`。施設責任者の手動再生成（§3.2）。 */
export const taskGenerateRequestSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
});

export type TaskGenerateRequest = z.infer<typeof taskGenerateRequestSchema>;

/** 生成結果。**件数だけを返す。** */
export const taskGenerateResponseSchema = z.object({
  businessDate: businessDateSchema,
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  cancelled: z.number().int().min(0),
  revived: z.number().int().min(0),
});

export type TaskGenerateResponse = z.infer<typeof taskGenerateResponseSchema>;

// ────────────────────────────────────────────────────────────
// 当日の客室状況（P1-04 / W-05）
// ────────────────────────────────────────────────────────────

/** 1 客室ぶんの入力。 */
export const roomPlanEntrySchema = z.object({
  roomId: resourceIdSchema,
  hasCheckout: z.boolean(),
  hasCheckin: z.boolean(),
  isStayover: z.boolean(),
  /** **人数のみ。** 宿泊者の氏名・連絡先を受け取る口を作らない（security.md §3）。 */
  guestCount: z.number().int().min(0).max(99),
  declineClean: z.boolean(),
});

export type RoomPlanEntry = z.infer<typeof roomPlanEntrySchema>;

/** `PUT /api/v1/room-plans`。画面での一括入力（§3.4 の手段 2）。 */
export const roomPlanUpsertRequestSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
  entries: z.array(roomPlanEntrySchema).max(2000),
});

export type RoomPlanUpsertRequest = z.infer<typeof roomPlanUpsertRequestSchema>;

/** `POST /api/v1/room-plans/import`。CSV 取込（§3.4 の手段 1）。 */
export const roomPlanImportRequestSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
  /** ヘッダ行を含む CSV 本文。列は §3.4 の 7 列。 */
  csv: z.string().max(1_000_000),
});

export type RoomPlanImportRequest = z.infer<typeof roomPlanImportRequestSchema>;

/**
 * `POST /api/v1/room-plans/all-checkout`。**「全室アウト清掃として生成」**
 *
 * §3.4 の MUST。データ入力を諦めても運用できる逃げ道。
 * 導入初日から完璧なデータ入力を求めると、現場が紙に戻る。
 */
export const roomPlanAllCheckoutRequestSchema = z.object({
  propertyId: resourceIdSchema,
  businessDate: businessDateSchema,
});

export type RoomPlanAllCheckoutRequest = z.infer<typeof roomPlanAllCheckoutRequestSchema>;

/** 取込・一括入力の結果。**取り込めなかった行は捨てずに返す。** */
export const roomPlanUpsertResponseSchema = z.object({
  businessDate: businessDateSchema,
  applied: z.number().int().min(0),
  /** 客室番号が客室マスタに無かった行。画面が一覧で示す。 */
  unknownRoomNumbers: z.array(z.string()),
  /** 形が読み取れなかった行の番号（1 始まり・ヘッダを除く）。 */
  skippedLines: z.array(z.number().int().positive()),
});

export type RoomPlanUpsertResponse = z.infer<typeof roomPlanUpsertResponseSchema>;

// ────────────────────────────────────────────────────────────
// 標準時間マスタ（P1-02 / W-17）
// ────────────────────────────────────────────────────────────

/** 1 件の標準時間。 */
export const standardTimeEntrySchema = z.object({
  roomTypeId: resourceIdSchema,
  taskType: taskTypeSchema,
  /**
   * 目安時間（分）。**0 を許さない。** 0 分のタスクは負荷の可視化（§4.3）で
   * 「割り当てても何も増えない」ことになり、上限の判定が意味を失う。
   * 上限 480 分は 1 勤務ぶん。
   */
  minutes: z.number().int().min(1).max(480),
});

export type StandardTimeEntry = z.infer<typeof standardTimeEntrySchema>;

/** `PUT /api/v1/standard-times`。施設ごとにまとめて設定する。 */
export const standardTimeUpsertRequestSchema = z.object({
  propertyId: resourceIdSchema,
  entries: z.array(standardTimeEntrySchema).max(200),
});

export type StandardTimeUpsertRequest = z.infer<typeof standardTimeUpsertRequestSchema>;

/** `GET /api/v1/standard-times` の応答。 */
export const standardTimeListResponseSchema = z.object({
  propertyId: z.string(),
  data: z.array(standardTimeEntrySchema),
});

export type StandardTimeListResponse = z.infer<typeof standardTimeListResponseSchema>;
