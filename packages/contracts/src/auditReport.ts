/**
 * 月次監査レポート API の入出力（PK-SPEC-P4 §7・§8）。
 *
 * task: docs/tasks/P4-14.md
 *
 * ```
 * POST /api/v1/reports/audit/monthly
 * GET  /api/v1/reports/audit/monthly/download?propertyId=&month=
 * ```
 *
 * ── 免責文を受け取る欄が無い ────────────────────────────
 * §7.2 MUST「削除・編集できない実装にする」。文言は `@pk/engine` の
 * `AUDIT_REPORT_DISCLAIMER` が唯一の出どころで、**API からも
 * payload からも差し替えられない。**
 *
 * ── 版を持たない ────────────────────────────────────────
 * 日報（PK-SPEC-P2 §9.3）と違い、このレポートは発行済み帳票ではなく
 * 元データからいつでも作り直せる要約。同じ月を 2 回作れば同じ R2 の
 * キーへ同じ内容が載る（DECISIONS #119）。
 */

import { z } from "zod";

import { resourceIdSchema } from "./task.js";

/** 対象月（`YYYY-MM`）。 */
export const auditReportMonthSchema = z.string().regex(/^\d{4}-\d{2}$/);

export const auditReportGenerateRequestSchema = z.object({
  propertyId: resourceIdSchema,
  month: auditReportMonthSchema,
});

export type AuditReportGenerateRequest = z.infer<typeof auditReportGenerateRequestSchema>;

export const auditReportGenerateResponseSchema = z.object({
  status: z.literal("QUEUED"),
  propertyId: resourceIdSchema,
  month: auditReportMonthSchema,
});

export type AuditReportGenerateResponse = z.infer<typeof auditReportGenerateResponseSchema>;

export const auditReportDownloadResponseSchema = z.object({
  /** 15 分有効の署名付き URL（security.md §4）。 */
  url: z.string(),
  propertyId: resourceIdSchema,
  month: auditReportMonthSchema,
});

export type AuditReportDownloadResponse = z.infer<typeof auditReportDownloadResponseSchema>;
