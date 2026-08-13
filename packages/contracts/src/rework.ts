/**
 * 差戻し・再清掃 API の入出力（PK-SPEC-P2 §4.5〜§4.7 / §11.4）。
 *
 * task: docs/tasks/P2-07.md
 *
 * ── 応答に載せないもの ──────────────────────────────────
 * **合格した項目を返さない。** §4.6 の「清掃者は差戻し項目だけを表示できる」を
 * 型の側でも満たす。合格・対象外の項目を混ぜて「画面で絞る」形にすると、
 * 絞りが UX 上の措置になってしまう（CLAUDE.md §5「フロントの非表示は
 * 権限制御とみなさない」）。応答を組む側が `reworkVisibleItemIds()` を通す。
 *
 * **検査者の氏名を返さない。** 誰が差し戻したかは差戻しの内容と関係がなく、
 * 現場で名前が出ると内容ではなく人への反応になる（§1.2「差戻しは人ではなく
 * 項目に紐づける」）。`inspectorId` すら載せていない。
 *
 * ── 受け取らないもの ────────────────────────────────────
 * `status` を受け取らない。状態は操作（`start` / `complete` / `waive`）と
 * 現在の状態から決まる（`packages/engine` の `evaluateReworkTransition()`）。
 * `organizationId` / `propertyId` も無い（セッションと資源から解決する）。
 */

import { z } from "zod";

import { defectCodeSchema } from "./inspection.js";
import { businessDateSchema, resourceIdSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙
// ────────────────────────────────────────────────────────────

/** 差戻しの状態（§3.4 の `ReworkStatus`）。`packages/db` と同じ並び。 */
export const REWORK_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "WAIVED"] as const;

export const reworkStatusSchema = z.enum(REWORK_STATUSES);

export type ReworkStatusValue = (typeof REWORK_STATUSES)[number];

/** 免除の理由の長さ。**下限は 1 文字**（空文字を通さない / §4.7「理由必須」）。 */
export const WAIVE_REASON_MIN_LENGTH = 1;
export const WAIVE_REASON_MAX_LENGTH = 300;

/**
 * 免除後の客室の扱い（§4.7「客室を READY にするか BLOCKED にするか選択させる」）。
 *
 * **既定値を置かない。** どちらも運用上あり得る（軽微な設備不良なら販売する、
 * 使用に支障があるなら止める）ので、選ばせる。
 */
export const WAIVE_ROOM_OUTCOMES = ["READY", "BLOCKED"] as const;

export const waiveRoomOutcomeSchema = z.enum(WAIVE_ROOM_OUTCOMES);

export type WaiveRoomOutcomeValue = (typeof WAIVE_ROOM_OUTCOMES)[number];

// ────────────────────────────────────────────────────────────
// エラー
// ────────────────────────────────────────────────────────────

/**
 * 差戻し API 固有のエラーコード。
 *
 * **403 相当を足さないこと**（INV-31）。権限・担当外施設・別テナント・
 * 「自分に来た差戻しではない」はすべて 404 に潰す。
 */
export const REWORK_ERROR_CODES = [
  "INVALID_REQUEST",
  /** その状態からはできない操作（開始していない再清掃の完了など）。 */
  "INVALID_TRANSITION",
  /** 既に決着した差戻し（`RESOLVED` / `WAIVED`）への操作。 */
  "REWORK_ALREADY_SETTLED",
  /** 免除に理由が無い（§4.7）。 */
  "REASON_REQUIRED",
  /** 免除に関連する不具合報告が無い（§4.7）。 */
  "ISSUE_REPORT_REQUIRED",
  /** タスク側の状態が再清掃を受け付けない（§4.1 の状態遷移）。 */
  "TASK_INVALID_TRANSITION",
] as const;

export type ReworkErrorCode = (typeof REWORK_ERROR_CODES)[number];

/** エラー応答。**文言を載せない。** 画面が i18n キーへ写す。 */
export const reworkErrorSchema = z.object({
  error: z.enum(REWORK_ERROR_CODES),
});

export type ReworkError = z.infer<typeof reworkErrorSchema>;

// ────────────────────────────────────────────────────────────
// 差戻しの表示（§11.4 M-12）
// ────────────────────────────────────────────────────────────

/** 検査写真 1 枚（再清掃画面に出す）。**`storageKey` を返さない。** */
export const reworkPhotoSchema = z.object({
  photoId: z.string(),
  /** 15 分有効の署名付き URL（security.md §4）。 */
  url: z.string(),
});

export type ReworkPhoto = z.infer<typeof reworkPhotoSchema>;

/**
 * 差し戻された項目 1 件（§11.4 のワイヤー「浴室 > 鏡 / 水滴跡 / 指示 / 写真」）。
 *
 * **書き込み可能な値を持たない。** §4.6「元のチェックリスト結果は変更しない」。
 * 再清掃で清掃者が触るのは写真とタスクの状態だけで、項目の判定は
 * 次のラウンドの検査が決める。
 */
export const reworkItemSchema = z.object({
  checklistItemId: z.string(),
  /** 「浴室」など（§11.4 の第 1 階層）。 */
  section: z.string(),
  /** 言語ごとのラベル（「鏡」）。 */
  labels: z.record(z.string(), z.string()),
  /** 理由コード（「水滴跡」）。**FAIL には必ず入っている**（§4.3）。 */
  defectCode: defectCodeSchema.nullable(),
  /** 検査者の指示（「右下に水滴跡があります」）。 */
  note: z.string().nullable(),
  /** 検査時に撮った写真。**清掃者はこれを見て直す。** */
  photos: z.array(reworkPhotoSchema),
  sortOrder: z.number().int(),
});

export type ReworkItem = z.infer<typeof reworkItemSchema>;

/** 差戻し 1 件。 */
export const reworkSchema = z.object({
  reworkCycleId: z.string(),
  taskId: z.string(),
  propertyId: z.string(),
  roomNumber: z.string(),
  businessDate: businessDateSchema,
  /** 1, 2, 3…。**「1 回目」と表示する**（§11.4）。 */
  round: z.number().int().min(1),
  status: reworkStatusSchema,
  /** 理由コードを連ねた文字列。**担当者の評価ではない**（§1.3）。 */
  reasonSummary: z.string(),
  /** 再清掃期限（§1.2 の「再清掃期限: 14:30」）。無ければ `null`。 */
  dueAt: z.number().int().nullable(),
  startedAt: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
  /** 免除の理由（§4.7）。免除していなければ `null`。 */
  waivedReason: z.string().nullable(),
  /** 免除の根拠となった不具合報告（`issueReport.id`）。 */
  waivedIssueId: z.string().nullable(),
});

export type Rework = z.infer<typeof reworkSchema>;

/**
 * 差戻しの詳細（M-12 が読む）。
 *
 * `items` は**差し戻された項目だけ**（§4.6）。`taskStatus` を添えるのは、
 * 画面が「開始」と「完了」のどちらを出すかをタスク側の状態でも確かめるため。
 */
export const reworkDetailResponseSchema = z.object({
  data: reworkSchema,
  items: z.array(reworkItemSchema),
  /** タスクの現在の状態（`REWORK` / `IN_PROGRESS` / `AWAITING_INSPECTION`）。 */
  taskStatus: z.string(),
});

export type ReworkDetailResponse = z.infer<typeof reworkDetailResponseSchema>;

// ────────────────────────────────────────────────────────────
// 再清掃の開始・完了（§4.6）
// ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/reworks/:reworkCycleId/start`
 * `POST /api/v1/reworks/:reworkCycleId/complete`
 *
 * **本体を持たない。** 何を直したかは次のラウンドの検査が判定する（§4.6）。
 * 清掃者に「直したかどうか」を自己申告させる欄を作らない
 * （ui-writing.md §4「清掃員に『判断』させない」）。
 */
export const reworkActionRequestSchema = z.object({
  /** 端末側の時刻。**参考値**（サーバー時刻が正）。 */
  clientTs: z.number().int().optional(),
});

export type ReworkActionRequest = z.infer<typeof reworkActionRequestSchema>;

/** 開始・完了・免除の応答。 */
export const reworkActionResponseSchema = z.object({
  data: reworkSchema,
  /** 更新後のタスクの状態。 */
  taskStatus: z.string(),
  /** 再送で既に進んでいた（オフラインキューは 409 と同じく成功として扱う）。 */
  unchanged: z.boolean(),
});

export type ReworkActionResponse = z.infer<typeof reworkActionResponseSchema>;

// ────────────────────────────────────────────────────────────
// 免除（§4.7）
// ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/reworks/:reworkCycleId/waive`。
 *
 * **3 つとも必須。** §4.7 は理由と関連する `IssueReport` を必須とし、
 * 免除後の客室の扱いを選ばせる。`issueReportId` は
 * `resourceIdSchema`（`{orgShortId}__{prefix}_{ulid}`）で形式だけ検査する。
 * **実在の確認は `issueReport` 表ができてから**（P2-12 / DECISIONS #071）。
 */
export const reworkWaiveRequestSchema = z.object({
  reason: z.string().min(WAIVE_REASON_MIN_LENGTH).max(WAIVE_REASON_MAX_LENGTH),
  issueReportId: resourceIdSchema,
  roomOutcome: waiveRoomOutcomeSchema,
  clientTs: z.number().int().optional(),
});

export type ReworkWaiveRequest = z.infer<typeof reworkWaiveRequestSchema>;
