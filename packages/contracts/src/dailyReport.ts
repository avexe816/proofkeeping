/**
 * 日報の入出力（PK-SPEC-P2 §9 / §14.4）。
 *
 * task: docs/tasks/P2-14.md
 *
 * ── 削除・訂正のスキーマが 1 つも無い ───────────────────
 * 発行済み帳票は消さない・書き換えない（CLAUDE.md §4 / billing.md §2）。
 * 作り直しは「版を上げてもう 1 通作る」操作で、入力は生成と同じ。
 * **`dailyReportUpdateRequestSchema` に当たるものを足さないこと。**
 *
 * ── 生成の要求に `organizationId` が無い ────────────────
 * 組織はセッションから解決する（CLAUDE.md §4）。施設 ID だけを受け取り、
 * それが自組織のものかは ID の自己記述（第 2 層）とリポジトリ層が見る。
 */

import { z } from "zod";

import { businessDateSchema } from "./task.js";

/** 日報 1 件（一覧・詳細で共通）。 */
export const dailyReportSchema = z.object({
  reportId: z.string(),
  propertyId: z.string(),
  businessDate: businessDateSchema,
  /** `RPT-2026-0042`。**版が変わっても同じ番号**（§9.3）。 */
  documentNo: z.string(),
  revision: z.number().int().positive(),
  payloadSha256: z.string(),
  pdfSha256: z.string(),
  totalTasks: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(),
  failedFirstInspection: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  openLostItems: z.number().int().nonnegative(),
  generatedAt: z.number().int(),
  /** 手動再生成した `membership.id`。**自動生成では `null`**（§9.3）。 */
  generatedById: z.string().nullable(),
  /** 前の版の ID。初版は `null`。**旧版も一覧に出る。** */
  supersedesId: z.string().nullable(),
});

export type DailyReportSummary = z.infer<typeof dailyReportSchema>;

/**
 * 生成・再生成の要求（§14.4）。
 *
 * `POST /reports/daily/generate` は施設と業務日を取る。
 * `POST /reports/daily/:id/regenerate` は対象を URL で示すので本文を取らない。
 */
export const dailyReportGenerateRequestSchema = z.object({
  propertyId: z.string().min(1),
  businessDate: businessDateSchema,
});

export type DailyReportGenerateRequest = z.infer<typeof dailyReportGenerateRequestSchema>;

/**
 * 生成の応答。**PDF はここに載らない。**
 *
 * 生成は Queue で行う（§15 / architecture.md §5）ので、この応答は
 * 「受け付けた」だけを意味する。出来上がりは一覧・詳細で確かめる。
 */
export const dailyReportGenerateResponseSchema = z.object({
  status: z.literal("QUEUED"),
  propertyId: z.string(),
  businessDate: businessDateSchema,
});

export type DailyReportGenerateResponse = z.infer<typeof dailyReportGenerateResponseSchema>;

/** ダウンロード（§9.6）。**15 分有効の署名付き URL**（security.md §4）。 */
export const dailyReportDownloadResponseSchema = z.object({
  url: z.string(),
  documentNo: z.string(),
  revision: z.number().int().positive(),
  pdfSha256: z.string(),
});

export type DailyReportDownloadResponse = z.infer<typeof dailyReportDownloadResponseSchema>;
