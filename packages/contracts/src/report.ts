/**
 * 忘れ物・設備不具合 API の入出力（PK-SPEC-P2 §7・§8・§14.3）。
 *
 * task:  docs/tasks/P2-11.md, docs/tasks/P2-12.md
 * ルール: .claude/rules/security.md §3
 *
 * ── 持ち主に関する入力欄が 1 つも無い ───────────────────
 * §7.4 / security.md §3。氏名・住所・電話番号・メールを受け取る
 * スキーマを**後から足さないこと。** 連絡した事実は
 * `POST /lost-items/:id/owner-contacted`（本文なし）で記録する。
 *
 * ── 応答の出し分けは型では表さない ──────────────────────
 * §7.4「`CLEANER` は保管場所や返却先を閲覧不可」。`storageLocation` は
 * スキーマ上 `nullable` で、**サーバーが `CLEANER` には `null` を入れる**
 * （`lib/report/lostItem.ts`）。型を 2 つに分けると「どちらを返すか」の
 * 判断が呼び出し側に散る。**絞るのは 1 か所**にしておく。
 *
 * ── 状態を直接受け取らない ──────────────────────────────
 * `PATCH /:id/status` は**遷移先**を受け取り、現在の状態はサーバーが読む
 * （楽観的排他 / `advanceLostItem()`）。クライアントに現在の状態を
 * 申告させない。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙（`packages/db` と同じ並び）
// ────────────────────────────────────────────────────────────

/** 忘れ物の区分（§3.5）。 */
export const LOST_ITEM_CATEGORIES = [
  "VALUABLE",
  "ELECTRONICS",
  "CLOTHING",
  "BAG",
  "MEDICINE",
  "FOOD",
  "DOCUMENT",
  "OTHER",
] as const;

export const lostItemCategorySchema = z.enum(LOST_ITEM_CATEGORIES);

export type LostItemCategoryValue = (typeof LOST_ITEM_CATEGORIES)[number];

/** 忘れ物の状態（§3.5）。 */
export const LOST_ITEM_STATUSES = [
  "FOUND",
  "STORED",
  "REPORTED_TO_POLICE",
  "RETURN_PENDING",
  "RETURNED",
  "DISPOSED",
  "TRANSFERRED",
] as const;

export const lostItemStatusSchema = z.enum(LOST_ITEM_STATUSES);

export type LostItemStatusValue = (typeof LOST_ITEM_STATUSES)[number];

/** 不具合の区分（§3.6）。 */
export const ISSUE_CATEGORIES = [
  "CLEANING",
  "PLUMBING",
  "ELECTRICAL",
  "HVAC",
  "FURNITURE",
  "AMENITY",
  "SAFETY",
  "OTHER",
] as const;

export const issueCategorySchema = z.enum(ISSUE_CATEGORIES);

export type IssueCategoryValue = (typeof ISSUE_CATEGORIES)[number];

/** 不具合の重要度（§8.2）。 */
export const ISSUE_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export const issueSeveritySchema = z.enum(ISSUE_SEVERITIES);

export type IssueSeverityValue = (typeof ISSUE_SEVERITIES)[number];

/** 不具合の状態（§3.6）。 */
export const ISSUE_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
  "WONT_FIX",
] as const;

export const issueStatusSchema = z.enum(ISSUE_STATUSES);

export type IssueStatusValue = (typeof ISSUE_STATUSES)[number];

/** 自由記述の長さ。**下限 1 文字**（空文字を「入力した」と扱わない）。 */
export const DESCRIPTION_MAX_LENGTH = 500;
export const TITLE_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 300;

const shortText = z.string().min(1).max(NOTE_MAX_LENGTH);

// ────────────────────────────────────────────────────────────
// 忘れ物（§7 / §14.3）
// ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/lost-items`。
 *
 * **`businessDate` を受け取らない。** 発見時刻と施設の日締めから
 * サーバーが決める（architecture.md §7）。クライアントに業務日を
 * 申告させると、日付をまたぐ勤務で取り違えが起きる。
 */
export const lostItemCreateRequestSchema = z.object({
  roomId: resourceIdSchema,
  /** 発見時の清掃タスク。タスク外での発見は省略。 */
  taskId: resourceIdSchema.optional(),
  category: lostItemCategorySchema,
  /**
   * 品物の説明。**持ち主のことを書く欄ではない**（§7.5）。
   * 現金の金額もここへ書かない。
   */
  description: z.string().min(1).max(DESCRIPTION_MAX_LENGTH),
  /** 客室内の位置（「ベッド下」等）。住所ではない。 */
  foundLocation: z.string().min(1).max(NOTE_MAX_LENGTH),
  /** 端末側の発見時刻。**参考値**（サーバー時刻を正とする）。 */
  clientTs: z.number().int().optional(),
});

export type LostItemCreateRequest = z.infer<typeof lostItemCreateRequestSchema>;

/**
 * `PATCH /api/v1/lost-items/:id/status`。
 *
 * **`from`（現在の状態）を受け取らない**（冒頭の注記）。
 */
export const lostItemStatusRequestSchema = z.object({
  to: lostItemStatusSchema,
  note: shortText.optional(),
  /** `STORED` へ進むときの保管場所。**`CLEANER` は送れない**（権限で弾く）。 */
  storageLocation: shortText.optional(),
  policeReportNo: shortText.optional(),
  /** `DISPOSED` へ進むときの理由。§7.3 の「明示操作」の記録。**必須。** */
  disposalReason: shortText.optional(),
});

export type LostItemStatusRequest = z.infer<typeof lostItemStatusRequestSchema>;

/** 忘れ物 1 件の応答。**持ち主に関する値を 1 つも持たない。** */
export const lostItemSchema = z.object({
  lostItemId: z.string(),
  propertyId: z.string(),
  roomId: z.string(),
  businessDate: businessDateSchema,
  managementNo: z.string(),
  category: lostItemCategorySchema,
  description: z.string(),
  foundAtMs: z.number().int(),
  foundById: z.string(),
  foundLocation: z.string(),
  status: lostItemStatusSchema,
  /** **`CLEANER` には常に `null`**（§7.4 / 冒頭の注記）。 */
  storageLocation: z.string().nullable(),
  policeReportNo: z.string().nullable(),
  /** 連絡した事実だけ。**連絡先は持たない**（§7.4）。 */
  ownerContactedAtMs: z.number().int().nullable(),
  retentionDueAtMs: z.number().int().nullable(),
  /** §7.3 の警告の段階。**期限から状態を導いた結果ではない。** */
  warningLevel: z.enum(["NORMAL", "ATTENTION", "URGENT"]),
});

export type LostItemSummary = z.infer<typeof lostItemSchema>;

/** 忘れ物 API のエラー。**403 を足さない**（INV-31）。 */
export const LOST_ITEM_ERRORS = [
  "INVALID_REQUEST",
  /** 管理番号が採り直しても衝突し続けた。**再試行で直る。** */
  "NUMBER_CONFLICT",
  /** その遷移ができない（並行操作・再送）。 */
  "INVALID_TRANSITION",
  /** `DISPOSED` へ進むのに理由が無い（§7.3 の「明示操作」）。 */
  "DISPOSAL_REASON_REQUIRED",
  /** 写真が 1 枚も無い（§7.5）。 */
  "PHOTO_REQUIRED",
] as const;

export type LostItemErrorCode = (typeof LOST_ITEM_ERRORS)[number];

export interface LostItemError {
  error: LostItemErrorCode;
}

// ────────────────────────────────────────────────────────────
// 設備不具合（§8 / §14.3）
// ────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/issues`。
 *
 * §8.1 の必須はカテゴリ・重要度・タイトル・写真 1 枚以上。
 * **写真はここでは受け取らない**（別経路 `POST /issues/:id/photos`）。
 * 報告そのものを先に立てないと写真の置き場が決まらないため。
 * 写真ゼロのまま残る報告は W-10 が「写真なし」として出す。
 */
export const issueCreateRequestSchema = z.object({
  roomId: resourceIdSchema,
  taskId: resourceIdSchema.optional(),
  category: issueCategorySchema,
  severity: issueSeveritySchema,
  title: z.string().min(1).max(TITLE_MAX_LENGTH),
  description: z.string().min(1).max(DESCRIPTION_MAX_LENGTH),
  /**
   * `CRITICAL` の確認を通したか（§8.2 MUST「確認画面を出し、確定後に」）。
   *
   * **サーバー側でも要求する。** 画面の確認だけだと、API を直接叩けば
   * 確認なしで客室を止められる。`CRITICAL` でこれが `true` でなければ
   * `CONFIRMATION_REQUIRED` を返す。
   */
  confirmed: z.boolean().optional(),
  clientTs: z.number().int().optional(),
});

export type IssueCreateRequest = z.infer<typeof issueCreateRequestSchema>;

/** `PATCH /api/v1/issues/:id/status` / `POST /api/v1/issues/:id/resolve`。 */
export const issueStatusRequestSchema = z.object({
  to: issueStatusSchema,
  note: shortText.optional(),
  /** `RESOLVED` へ進むとき必須（DECISIONS #081）。 */
  resolutionNote: z.string().min(1).max(DESCRIPTION_MAX_LENGTH).optional(),
  assignedToId: resourceIdSchema.optional(),
});

export type IssueStatusRequest = z.infer<typeof issueStatusRequestSchema>;

/** 不具合 1 件の応答。 */
export const issueReportSchema = z.object({
  issueId: z.string(),
  propertyId: z.string(),
  roomId: z.string(),
  taskId: z.string().nullable(),
  category: issueCategorySchema,
  severity: issueSeveritySchema,
  title: z.string(),
  description: z.string(),
  status: issueStatusSchema,
  reportedById: z.string(),
  assignedToId: z.string().nullable(),
  reportedAtMs: z.number().int(),
  resolvedAtMs: z.number().int().nullable(),
  resolutionNote: z.string().nullable(),
  /** **この報告が客室を止めたか。** いま止まっているかではない（§8.3）。 */
  roomBlocked: z.boolean(),
});

export type IssueReportSummary = z.infer<typeof issueReportSchema>;

/** 不具合 API のエラー。 */
export const ISSUE_ERRORS = [
  "INVALID_REQUEST",
  /** `CRITICAL` なのに確認を通していない（§8.2 MUST）。 */
  "CONFIRMATION_REQUIRED",
  "INVALID_TRANSITION",
  /** `RESOLVED` へ進むのに解決内容が無い（DECISIONS #081）。 */
  "RESOLUTION_NOTE_REQUIRED",
] as const;

export type IssueErrorCode = (typeof ISSUE_ERRORS)[number];

export interface IssueError {
  error: IssueErrorCode;
}
