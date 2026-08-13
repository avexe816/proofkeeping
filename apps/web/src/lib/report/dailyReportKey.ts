/**
 * 日報 PDF の置き場と版（PK-SPEC-P2 §9.3 / §9.5）。**純粋関数。**
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/security.md §4（R2 のキー体系）
 *
 * ```
 * documents/{orgId}/{propertyId}/daily-reports/{YYYY}/{MM}/{documentNo}-r{revision}.pdf
 * ```
 *
 * ── 版がキーに入っているのが要点 ────────────────────────
 * §9.3「再生成は同じ文書番号を上書きしない。revision = 2 として
 * 新しい PDF を生成し、旧版を保持する」。**キーに版が入っていれば、
 * 上書きは構造として起こらない。** 「消さない運用」に頼らない。
 *
 * ── 年月は業務日から取る ────────────────────────────────
 * 生成日時ではなく業務日（architecture.md §7）。日締めをまたぐ生成で
 * 月が変わると、同じ月の日報が 2 つのフォルダに散る。
 *
 * ── シャード番号を含めない ──────────────────────────────
 * architecture.md §1。組織 ID は含む（バケットの中を組織で切るため /
 * 写真と同じ理由）。
 */

/** `DOCUMENTS` バケットの日報の接頭辞。**角印（`seals/`）とは別。** */
export const DAILY_REPORT_PREFIX = "documents/";

/** 日報 PDF の R2 キー。 */
export function dailyReportKey(input: {
  organizationId: string;
  propertyId: string;
  businessDate: string;
  documentNo: string;
  revision: number;
}): string {
  const [year = "0000", month = "00"] = input.businessDate.split("-");
  return (
    `${DAILY_REPORT_PREFIX}${input.organizationId}/${input.propertyId}/daily-reports/` +
    `${year}/${month}/${input.documentNo}-r${String(input.revision)}.pdf`
  );
}

/** 受け取った側のファイル名（`Content-Disposition`）。 */
export function dailyReportFileName(documentNo: string, revision: number): string {
  return `${documentNo}-r${String(revision)}.pdf`;
}

/**
 * 次の版（§9.3）。**最新版が無ければ 1。**
 *
 * 版は必ず 1 ずつ増える。**欠番を作らない**（帳票の番号 / billing.md §5 とは
 * 別の話で、こちらは「何度目の作り直しか」を表す連番）。
 */
export function nextRevision(latestRevision: number | undefined): number {
  return latestRevision === undefined ? 1 : latestRevision + 1;
}

/** そのキーが自組織のものか（署名付き URL の最後の砦 / `routes/api/v1/files.ts`）。 */
export function isOwnDailyReportKey(key: string, organizationId: string): boolean {
  return key.startsWith(`${DAILY_REPORT_PREFIX}${organizationId}/`);
}
