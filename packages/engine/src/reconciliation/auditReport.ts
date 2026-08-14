/**
 * 月次監査レポートの payload（PK-SPEC-P4 §7）。**純粋関数。**
 *
 * task:  docs/tasks/P4-14.md
 * ルール: .claude/rules/ui-writing.md §2（禁止語）
 *
 * ── 免責事項は編集できない（§7.2 MUST）─────────────────
 * `AUDIT_REPORT_DISCLAIMER` は**このモジュールの定数**で、payload にも
 * API にも「差し替える」経路が無い。テンプレートは定数を直に読む
 * （`packages/pdf/src/auditReport.ts`）。
 * **文面を引数に取る関数を作らないこと。**
 *
 * ── 集計はここだけ ──────────────────────────────────────
 * PDF テンプレートは payload の値をそのまま出す（日報と同じ方針）。
 * 合計を 2 か所で取ると、紙と画面で数字が食い違う。
 *
 * ── これは不正の認定ではない ────────────────────────────
 * §1.1。語彙に「不正」「検知」「監視」「疑わしい」を出さない。
 * レポートの表題は「稼働照合レポート」。
 */

/**
 * 免責事項（§7.2 MUST・全文固定）。
 *
 * **1 文字も変えないこと。** §7.2 が全文を定めており、`auditReport.spec.ts`
 * が文字列そのものを固定している。改行を入れる・句読点を変えるだけでも
 * テストが落ちる。
 */
export const AUDIT_REPORT_DISCLAIMER =
  "本レポートは、清掃現場の記録と稼働記録の差異を機械的に抽出したものであり、" +
  // **ここだけ禁止語の検査を外す。** ui-writing.md §2 は「不正」を
  // 使わないと定めるが、§7.2 の免責文は**「不正行為を認定するもの
  // ではありません」と否定するために**その語を必要とする。
  // 言い換えると否定が弱まり、免責の意味が失われる。
  // **他の場所でこの逃げ道を使わないこと**（免責文はこの 1 か所だけ）。
  // eslint-disable-next-line pk/no-forbidden-words -- PK-SPEC-P4 §7.2 の全文固定
  "特定の個人による不正行為を認定するものではありません。" +
  "差異には、設備の不具合、記録の遅延や漏れ、業務手順上の例外、" +
  "システム連携のタイムラグなど、多様な原因が含まれます。" +
  "本レポートの内容を根拠として人事上の措置を行う場合は、" +
  "必ず個別の事実確認を実施してください。";

/** 重要度（§2.5）。**並びは高い順。** */
export const AUDIT_SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** 1 か月ぶんの重要度別件数（§7.1 の「2. 重要度別の推移（12か月）」）。 */
export interface AuditMonthlyTrend {
  /** `YYYY-MM`。 */
  month: string;
  high: number;
  medium: number;
  low: number;
}

/** 差異 1 件（§7.1 の「3. 重要度 高 の全件詳細」「4. 未対応項目一覧」）。 */
export interface AuditFindingLine {
  businessDate: string;
  roomNumber: string;
  ruleCode: string;
  severity: AuditSeverity;
  confidence: number;
  title: string;
  status: string;
  resolutionCode: string | null;
}

/** ルールごとの検出件数と誤りの割合（§7.1 の「5.」）。 */
export interface AuditRuleLine {
  ruleCode: string;
  title: string;
  total: number;
  /** 対象外として閉じた件数。 */
  dismissed: number;
  /**
   * 対象外の割合（千分率）。**母数が 0 なら `null`。**
   * 0% と「まだ 1 件も無い」を混ぜない。
   */
  dismissedPermille: number | null;
}

/** `buildAuditReportPayload()` の入力。**すべて呼び出し側が集めた事実。** */
export interface AuditReportInput {
  property: { id: string; name: string };
  /** `YYYY-MM`。 */
  month: string;
  /** 対象期間（両端を含む業務日）。 */
  from: string;
  to: string;
  engineVersion: string;
  rulesetHash: string;
  /** 評価対象の客室日数（§7.1 の「評価対象客室日数」）。 */
  roomDays: number;
  /** 揃っていた系統（§1.2）。 */
  availableSources: readonly string[];
  suppressedCount: number;
  findings: readonly AuditFindingLine[];
  trend: readonly AuditMonthlyTrend[];
  rules: readonly AuditRuleLine[];
}

/** §7.1 の「1. サマリー」。 */
export interface AuditReportSummary {
  roomDays: number;
  availableSources: readonly string[];
  total: number;
  high: number;
  medium: number;
  low: number;
  suppressed: number;
  resolved: number;
  dismissed: number;
  open: number;
}

/** 月次監査レポートの payload（§7.1 の 6 節）。 */
export interface AuditReportPayload {
  property: { id: string; name: string };
  month: string;
  from: string;
  to: string;
  engineVersion: string;
  rulesetHash: string;
  /** 1. サマリー */
  summary: AuditReportSummary;
  /** 2. 重要度別の推移（12 か月） */
  trend: readonly AuditMonthlyTrend[];
  /** 3. 重要度 高 の全件詳細 */
  highFindings: readonly AuditFindingLine[];
  /** 4. 未対応項目一覧 */
  openFindings: readonly AuditFindingLine[];
  /** 5. ルール別の検出件数と誤りの割合 */
  rules: readonly AuditRuleLine[];
  /** 6. 免責事項。**固定文言**（§7.2 MUST）。 */
  disclaimer: string;
}

/** 状態の語彙（`packages/db` の `FINDING_STATUSES` と同じ並び）。 */
const RESOLVED_STATUS = "RESOLVED";
const DISMISSED_STATUS = "FALSE_POSITIVE";
const OPEN_STATUSES: ReadonlySet<string> = new Set(["OPEN", "REVIEWING"]);

/**
 * 業務日の並びで安定させる比較（§10.1 の決定性）。
 *
 * **新しい順・重要度の高い順・部屋番号順。** 同じ月を 2 回出しても
 * 同じ並びになる。
 */
function compareLines(a: AuditFindingLine, b: AuditFindingLine): number {
  if (a.businessDate !== b.businessDate) return a.businessDate < b.businessDate ? 1 : -1;
  const bySeverity =
    AUDIT_SEVERITIES.indexOf(a.severity) - AUDIT_SEVERITIES.indexOf(b.severity);
  if (bySeverity !== 0) return bySeverity;
  if (a.roomNumber !== b.roomNumber) return a.roomNumber < b.roomNumber ? -1 : 1;
  return a.ruleCode < b.ruleCode ? -1 : a.ruleCode > b.ruleCode ? 1 : 0;
}

/**
 * payload を組み立てる（§7.1）。
 *
 * **`disclaimer` は入力に取らない。** 差し替えの経路を作らないことが
 * §7.2 MUST「削除・編集できない実装にする」の実体。
 */
export function buildAuditReportPayload(input: AuditReportInput): AuditReportPayload {
  const findings = [...input.findings].sort(compareLines);

  const summary: AuditReportSummary = {
    roomDays: input.roomDays,
    availableSources: [...input.availableSources],
    total: findings.length,
    high: findings.filter((line) => line.severity === "HIGH").length,
    medium: findings.filter((line) => line.severity === "MEDIUM").length,
    low: findings.filter((line) => line.severity === "LOW").length,
    suppressed: input.suppressedCount,
    resolved: findings.filter((line) => line.status === RESOLVED_STATUS).length,
    dismissed: findings.filter((line) => line.status === DISMISSED_STATUS).length,
    open: findings.filter((line) => OPEN_STATUSES.has(line.status)).length,
  };

  return {
    property: { ...input.property },
    month: input.month,
    from: input.from,
    to: input.to,
    engineVersion: input.engineVersion,
    rulesetHash: input.rulesetHash,
    summary,
    trend: [...input.trend],
    highFindings: findings.filter((line) => line.severity === "HIGH"),
    openFindings: findings.filter((line) => OPEN_STATUSES.has(line.status)),
    rules: [...input.rules],
    disclaimer: AUDIT_REPORT_DISCLAIMER,
  };
}

/**
 * ルール別の集計（§7.1 の「5.」）。
 *
 * **「誤検知率」とは呼ばない**（ui-writing.md §2）。数えているのは
 * 「対象外として閉じた割合」で、ルールが間違っていたかの認定ではない。
 */
export function buildRuleLines(
  findings: readonly AuditFindingLine[],
  titleOf: (ruleCode: string) => string,
): AuditRuleLine[] {
  const byRule = new Map<string, { total: number; dismissed: number }>();
  for (const line of findings) {
    const current = byRule.get(line.ruleCode) ?? { total: 0, dismissed: 0 };
    current.total += 1;
    if (line.status === DISMISSED_STATUS) current.dismissed += 1;
    byRule.set(line.ruleCode, current);
  }

  return [...byRule.entries()]
    .map(([ruleCode, counts]) => ({
      ruleCode,
      title: titleOf(ruleCode),
      total: counts.total,
      dismissed: counts.dismissed,
      dismissedPermille:
        counts.total === 0 ? null : Math.round((counts.dismissed * 1000) / counts.total),
    }))
    // **コード順。** 件数順にすると月ごとに並びが変わり、前月と見比べにくい。
    .sort((a, b) => (a.ruleCode < b.ruleCode ? -1 : a.ruleCode > b.ruleCode ? 1 : 0));
}
