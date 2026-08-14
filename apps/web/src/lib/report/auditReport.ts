/**
 * 月次監査レポートの集計（PK-SPEC-P4 §7）。
 *
 * task:  docs/tasks/P4-14.md
 * ルール: .claude/rules/architecture.md §5
 *
 * ── ここは読むだけ ──────────────────────────────────────
 * DB から事実を集めて `buildAuditReportPayload()`（純粋関数）へ渡す。
 * **合計はここで取らない**（engine が唯一の集計点 / 日報と同じ方針）。
 *
 * ── 呼ぶのは Queue コンシューマ ─────────────────────────
 * 1 か月ぶんの差異と 12 か月ぶんの推移を読む。**リクエストハンドラの
 * CPU 予算（50ms）に収まらない**（architecture.md §5）。
 */

import {
  countFindingsByMonth,
  findPropertyById,
  listFindings,
  listReconciliationRuns,
  listRoomNumbersByIds,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  RECONCILIATION_ENGINE_VERSION,
  buildAuditReportPayload,
  buildRuleLines,
  findRule,
  type AuditFindingLine,
  type AuditMonthlyTrend,
  type AuditReportPayload,
} from "@pk/engine";

import { monthRangeOf } from "../baseline/dataQuality.js";
import { shiftBusinessDate } from "../businessDate.js";

/** §7.1 の「2. 重要度別の推移（12か月）」。 */
export const TREND_MONTHS = 12;

/**
 * 12 か月ぶんの月キーを新しい順→古い順で並べる。
 *
 * **`Date` の月計算を使わない。** `YYYY-MM` の text をそのまま減らす
 * （業務日と同じ扱い / architecture.md §7）。
 */
export function trendMonthsOf(month: string, count: number = TREND_MONTHS): string[] {
  const [yearText, monthText] = month.split("-");
  let year = Number.parseInt(yearText ?? "", 10);
  let index = Number.parseInt(monthText ?? "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(index)) return [];

  const months: string[] = [];
  for (let step = 0; step < count; step += 1) {
    months.push(`${String(year).padStart(4, "0")}-${String(index).padStart(2, "0")}`);
    index -= 1;
    if (index === 0) {
      index = 12;
      year -= 1;
    }
  }
  // **古い順に返す。** 表は左から右へ時間が進むほうが読める。
  return months.reverse();
}

/**
 * 1 施設・1 か月ぶんの payload を組み立てる（§7.1）。
 *
 * @returns 施設が無ければ `null`（呼び出し側が 404 / SKIPPED に写す）。
 */
export async function collectAuditReport(
  env: Env,
  ctx: TenantContext,
  input: { propertyId: string; month: string },
): Promise<AuditReportPayload | null> {
  const range = monthRangeOf(input.month);
  if (range === null) return null;

  const property = await findPropertyById(env, ctx, input.propertyId);
  if (property === undefined) return null;

  const months = trendMonthsOf(input.month);
  const trendFrom = `${months[0] ?? input.month}-01`;

  const [findingRows, runs, trendRows] = await Promise.all([
    // **上限を上げてある。** 月次のレポートは全件を載せる（§7.1 の
    // 「3. 重要度 高 の全件詳細」）。既定の 200 では切れる。
    listFindings(env, ctx, {
      propertyId: input.propertyId,
      from: range.from,
      to: range.to,
      limit: 2000,
    }),
    listReconciliationRuns(env, ctx, {
      propertyId: input.propertyId,
      from: range.from,
      to: range.to,
      limit: 400,
    }),
    countFindingsByMonth(env, ctx, {
      propertyId: input.propertyId,
      from: trendFrom,
      to: range.to,
    }),
  ]);

  const roomNumbers = await listRoomNumbersByIds(
    env,
    ctx,
    findingRows.map((row) => row.roomId),
  );

  const findings: AuditFindingLine[] = findingRows.map((row) => ({
    businessDate: row.businessDate,
    roomNumber: roomNumbers.get(row.roomId) ?? "",
    ruleCode: row.ruleCode,
    severity: row.severity,
    confidence: row.confidence,
    title: row.title,
    status: row.status,
    resolutionCode: row.resolutionCode,
  }));

  // 抑制は施設 × 業務日の最大値を採ってから合計する（`sumSuppressedFindings()`
  // と同じ理由 —— `engineVersion` 違いの Run を二重に数えない）。
  const suppressedByDate = new Map<string, number>();
  for (const run of runs) {
    const current = suppressedByDate.get(run.businessDate) ?? 0;
    suppressedByDate.set(run.businessDate, Math.max(current, run.findingsSuppressed));
  }
  const roomDaysByDate = new Map<string, number>();
  for (const run of runs) {
    const current = roomDaysByDate.get(run.businessDate) ?? 0;
    roomDaysByDate.set(run.businessDate, Math.max(current, run.roomsEvaluated));
  }

  // **揃っていた系統は「その月に一度でも揃った」もの。** 日ごとに違いうるが、
  // §7.1 のサマリーは月の 1 行。欠けた日があったことは 2. の推移に出る。
  const availableSources = [
    ...new Set(runs.flatMap((run) => run.availableSources)),
  ].sort();

  const trend: AuditMonthlyTrend[] = months.map((month) => {
    const rows = trendRows.filter((row) => row.month === month);
    const countOf = (severity: string): number =>
      rows.find((row) => row.severity === severity)?.count ?? 0;
    return {
      month,
      high: countOf("HIGH"),
      medium: countOf("MEDIUM"),
      low: countOf("LOW"),
    };
  });

  return buildAuditReportPayload({
    property: { id: property.id, name: property.name },
    month: input.month,
    from: range.from,
    to: range.to,
    engineVersion: RECONCILIATION_ENGINE_VERSION,
    // **その月に走った照合の設定の指紋。** 月内で設定を変えていれば
    // 複数ありうるので、最後に走ったものを載せる（§2.4）。
    rulesetHash: runs[0]?.rulesetHash ?? "",
    roomDays: [...roomDaysByDate.values()].reduce((total, value) => total + value, 0),
    availableSources,
    suppressedCount: [...suppressedByDate.values()].reduce((total, value) => total + value, 0),
    findings,
    trend,
    rules: buildRuleLines(findings, (ruleCode) => findRule(ruleCode)?.title ?? ruleCode),
  });
}

/**
 * 月次レポートの R2 キー。
 *
 * ── 表に行を持たない（DECISIONS #119）────────────────────
 * §7 は保存先の表を定めていない。**このレポートは元データから何度でも
 * 作り直せる**（発行済み帳票ではない）ので、決まったキーへ置き直す形に
 * してある。同じ月を 2 回作れば同じキーに同じ内容が載る（冪等）。
 */
export function auditReportKey(input: {
  organizationId: string;
  propertyId: string;
  month: string;
}): string {
  return `audit-reports/${input.organizationId}/${input.propertyId}/${input.month}.pdf`;
}

/** 前月の `YYYY-MM`（cron から呼ぶときの既定）。 */
export function previousMonthOf(businessDate: string): string {
  return shiftBusinessDate(`${businessDate.slice(0, 7)}-01`, -1).slice(0, 7);
}
