/**
 * 業務上の入室記録 API の入出力（PK-SPEC-P4 §2.3・§4.1）。
 *
 * task: docs/tasks/P4-10.md
 *
 * ```
 * GET  /api/v1/room-access-logs?propertyId=&from=&to=
 * POST /api/v1/room-access-logs
 * ```
 *
 * ── これは「言い訳を後から書く欄」ではない ──────────────
 * §2.3 は事前・事後の両方の登録を認めている。登録された客室・業務日の
 * 差異は抑制される（§4.1）ので、**誰が登録できるかが効く。**
 * 現場ロール（`CLEANER` / `INSPECTOR`）には書けない
 * （`permission.ts` の `roomAccess.write` / DECISIONS #112）。
 *
 * ── 業務日を受け取らない ────────────────────────────────
 * `enteredAt` と施設の日締め時刻から**サーバーが決める**
 * （architecture.md §7）。クライアントに業務日を選ばせると、
 * 「入室した日」と「抑制する日」を別々に指定できてしまう。
 *
 * ── 宿泊者を書く欄が無い ────────────────────────────────
 * `actorName` は立ち入った担当者（従業員・業者）で、宿泊者ではない
 * （security.md §3・§5）。氏名以外の連絡先を持たせないこと。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

/** API のエラーコード。**文言を載せない**（画面が i18n キーへ写す）。 */
export const ROOM_ACCESS_ERROR_CODES = ["INVALID_REQUEST", "NOT_FOUND"] as const;

export type RoomAccessErrorCode = (typeof ROOM_ACCESS_ERROR_CODES)[number];

export const roomAccessErrorSchema = z.object({ error: z.enum(ROOM_ACCESS_ERROR_CODES) });

export type RoomAccessError = z.infer<typeof roomAccessErrorSchema>;

/** 入室の目的（§2.3）。`packages/db` の `ROOM_ACCESS_PURPOSES` と同じ並び。 */
export const ROOM_ACCESS_PURPOSES = [
  "INSPECTION",
  "MAINTENANCE",
  "VENDOR_VISIT",
  "SHOWING",
  "TRAINING",
  "OTHER",
] as const;

export const roomAccessPurposeSchema = z.enum(ROOM_ACCESS_PURPOSES);

export type RoomAccessPurposeValue = (typeof ROOM_ACCESS_PURPOSES)[number];

/** 立ち入った担当者名の長さ。 */
export const ROOM_ACCESS_ACTOR_NAME_MAX_LENGTH = 64;

/** 備考の長さ。 */
export const ROOM_ACCESS_NOTE_MAX_LENGTH = 500;

/**
 * 登録できる時刻の幅（前後の日数）。
 *
 * 遡れる幅は照合の遡及（§5.4 の 90 日）に合わせる。**未来側は 30 日。**
 * 事前登録は「来週の点検」までで足り、それより先を許すと、
 * 押し忘れた登録がいつまでも抑制として効き続ける。
 */
export const ROOM_ACCESS_MAX_PAST_DAYS = 90;
export const ROOM_ACCESS_MAX_FUTURE_DAYS = 30;

/**
 * 登録（§2.3）。
 *
 * **`businessDate` を受け取らない**（冒頭の注記）。`exitedAt` は
 * 退出が済んでいないうちは `null`。
 */
export const roomAccessCreateRequestSchema = z
  .object({
    roomId: resourceIdSchema,
    purpose: roomAccessPurposeSchema,
    /** epoch ミリ秒。 */
    enteredAt: z.number().int(),
    exitedAt: z.number().int().nullable().default(null),
    actorName: z.string().max(ROOM_ACCESS_ACTOR_NAME_MAX_LENGTH).nullable().default(null),
    note: z.string().max(ROOM_ACCESS_NOTE_MAX_LENGTH).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.exitedAt !== null && value.exitedAt < value.enteredAt) {
      ctx.addIssue({ code: "custom", path: ["exitedAt"], message: "BEFORE_ENTERED" });
    }
  });

export type RoomAccessCreateRequest = z.infer<typeof roomAccessCreateRequestSchema>;

/** 1 件（一覧・登録の応答）。 */
export const roomAccessLogSchema = z.object({
  id: resourceIdSchema,
  propertyId: resourceIdSchema,
  roomId: resourceIdSchema,
  roomNumber: z.string(),
  businessDate: businessDateSchema,
  purpose: roomAccessPurposeSchema,
  enteredAt: z.number().int(),
  exitedAt: z.number().int().nullable(),
  actorName: z.string().nullable(),
  note: z.string().nullable(),
  registeredAt: z.number().int(),
});

export type RoomAccessLogSummary = z.infer<typeof roomAccessLogSchema>;

export const roomAccessListResponseSchema = z.object({ data: z.array(roomAccessLogSchema) });

export type RoomAccessListResponse = z.infer<typeof roomAccessListResponseSchema>;

export const roomAccessCreateResponseSchema = z.object({ data: roomAccessLogSchema });

export type RoomAccessCreateResponse = z.infer<typeof roomAccessCreateResponseSchema>;
