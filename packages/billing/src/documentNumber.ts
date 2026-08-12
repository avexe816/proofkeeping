/**
 * 書類番号の組み立てと会計年度の判定。**純粋関数。**
 *
 * task:  docs/tasks/P0-17.md
 * ルール: .claude/rules/billing.md §5
 *
 * ── ここに DB・fetch・現在時刻を持ち込まない ────────────
 * `packages/billing` の約束（CLAUDE.md §5）。日付は引数で受け取る。
 * 採番そのものは `DocumentSequencer`（Durable Object）が行い、
 * このファイルは**採番された整数を文字列にするところだけ**を持つ。
 *
 * ── 「西暦」と「会計年度」の関係 ────────────────────────
 * billing.md §5 は書式を `INV-{西暦}-{連番4桁}` と定め、同時に
 * 「会計年度の切替で連番をリセットする」と定める。両立させるには
 * **番号に載る西暦＝会計年度が始まった年**でなければならない。
 * 暦年を載せると、3 月と 4 月で同じ西暦のまま連番が 1 に戻り、
 * 同じ番号が 2 回出る（`INV-2026-0001` が 1 月と 4 月に 1 本ずつ）。
 *
 * `documentSequence.fiscalYear`（P0-06）の列コメント「西暦」も
 * この意味で読む。開始月 4 なら
 *
 *   2026-03-31 → 2025 年度（`INV-2025-…`）
 *   2026-04-01 → 2026 年度（`INV-2026-…`）
 */

/** 採番する書類の種別。`packages/db` の `DOCUMENT_TYPES` と同じ並び。 */
export const DOCUMENT_TYPES = ["INVOICE", "RECEIPT", "REPORT"] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** 書式の接頭辞（billing.md §5）。**一度使った接頭辞を変えないこと。** */
export const DOCUMENT_NUMBER_PREFIXES: Record<DocumentType, string> = {
  INVOICE: "INV",
  RECEIPT: "RCP",
  REPORT: "RPT",
};

/** 連番の桁数。**下限であって上限ではない**（下の注記）。 */
export const DOCUMENT_NUMBER_DIGITS = 4;

/**
 * 書類番号を組み立てる。
 *
 * ```
 * formatDocumentNumber("INVOICE", 2026, 42) === "INV-2026-0042"
 * ```
 *
 * ── 10,000 件目で桁を増やす。折り返さない ───────────────
 * `9999` の次は `INV-2026-10000`。4 桁に丸めて `0000` へ戻すと
 * 同じ番号が 2 回出る。**一度採番した番号は再利用しない**
 * （billing.md §5）ほうが、桁が揃うことより重い。
 *
 * @throws `INVALID_SEQUENCE` 連番が 1 以上の整数でない場合。
 *         0 と負数を弾くのは、採番の失敗が `-1` や `0` として
 *         そのまま帳票に載るのを防ぐため。
 * @throws `INVALID_FISCAL_YEAR` 年が 4 桁の整数でない場合。
 */
export function formatDocumentNumber(
  documentType: DocumentType,
  fiscalYear: number,
  sequence: number,
): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("INVALID_SEQUENCE");
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1000 || fiscalYear > 9999) {
    throw new Error("INVALID_FISCAL_YEAR");
  }
  const prefix = DOCUMENT_NUMBER_PREFIXES[documentType];
  const padded = String(sequence).padStart(DOCUMENT_NUMBER_DIGITS, "0");
  return `${prefix}-${String(fiscalYear)}-${padded}`;
}

/**
 * 取引年月日から会計年度（西暦）を求める。
 *
 * `date` は `YYYY-MM-DD`。**`Date` を受け取らない。** 業務日は施設の
 * 日締め時刻で決まる文字列であって（architecture.md §7）、
 * タイムゾーンを持つ時刻ではない。ここで `Date` に変換すると
 * UTC 解釈で 1 日ずれる余地が生まれる。
 *
 * @param fiscalYearStartMonth 1〜12。`organizationTaxProfile` の既定は 4。
 * @throws `INVALID_BUSINESS_DATE` / `INVALID_FISCAL_YEAR_START_MONTH`
 */
export function fiscalYearOf(date: string, fiscalYearStartMonth: number): number {
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
    throw new Error("INVALID_FISCAL_YEAR_START_MONTH");
  }
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (matched === null) throw new Error("INVALID_BUSINESS_DATE");

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error("INVALID_BUSINESS_DATE");

  // 開始月より前なら前年度。開始月 1（暦年と一致）なら常に同じ年になる。
  return month < fiscalYearStartMonth ? year - 1 : year;
}

/**
 * `DocumentSequencer` のインスタンス名。**粒度は 組織 × 文書種別 × 年度**
 * （architecture.md §4）。
 *
 * 年度をインスタンス名に含めることが「会計年度の切替でリセットする」の
 * 実装そのものになっている。**年度をまたぐと別インスタンスになり、
 * カウンタは 0 から始まる。** リセット処理を書かないこと。書くと
 * 「過去年度のインスタンスを間違って初期化する」経路ができる。
 */
export function documentSequencerName(
  organizationId: string,
  documentType: DocumentType,
  fiscalYear: number,
): string {
  return `${organizationId}|${documentType}|${String(fiscalYear)}`;
}
