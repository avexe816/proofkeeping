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
export { DAILY_REPORT_LABELS } from "./labels.js";
