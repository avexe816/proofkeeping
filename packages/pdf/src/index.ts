/**
 * 帳票テンプレート。**Queue コンシューマ内でのみ実行する**（CLAUDE.md §2）。
 *
 * P2-14 が日報（PK-SPEC-P2 §9）を足した。請求書・領収書は P5。
 */

export { buildDailyReportDocument, type DailyReportFont } from "./dailyReport.js";
export { registerFont, renderDailyReportPdf } from "./render.js";
export {
  formatBusinessDate,
  formatClock,
  formatCount,
  formatDateTime,
  formatMinutes,
  formatReworkCount,
} from "./format.js";
export { DAILY_REPORT_LABELS, AUDIT_REPORT_LABELS } from "./labels.js";

// 月次監査レポート（P4-14 / PK-SPEC-P4 §7）。**免責文は差し替えられない。**
export { buildAuditReportDocument, type AuditReportFont } from "./auditReport.js";
export { renderAuditReportPdf } from "./render.js";
