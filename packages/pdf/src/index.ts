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

// 請求書（P5-06 / PK-SPEC-P5 §8.1）。**適格請求書の 6 要件を満たす。**
// 描画は Queue コンシューマ内でのみ行う（§8.3 MUST）。
export {
  buildInvoiceDocument,
  type InvoiceFont,
  type InvoiceSeal,
} from "./invoice.js";
export { renderInvoicePdf } from "./render.js";
export { INVOICE_LABELS } from "./labels.js";

// 領収書（P5-08 / PK-SPEC-P5 §8.2）。**印紙貼付欄を持たない**（billing.md §3）。
export { buildReceiptDocument } from "./receipt.js";
export { renderReceiptPdf } from "./render.js";
export { RECEIPT_LABELS } from "./labels.js";

// 支払明細書（P5-18 追送 / PK-SPEC-PAY §3.2）。**控除の欄を持たない。**
export { buildPayoutStatementDocument } from "./payoutStatement.js";
export { renderPayoutStatementPdf } from "./render.js";
export { PAYOUT_LABELS } from "./labels.js";
