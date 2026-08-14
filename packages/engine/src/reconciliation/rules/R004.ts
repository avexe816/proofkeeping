/**
 * R004 — 退室日と清掃日の相違（PK-SPEC-P4 §3.5）。**純粋関数。**
 *
 * task: docs/tasks/P4-11.md
 *
 * ```
 * occupancy.checkOutAt が存在
 * かつ アウト清掃が checkOutAt の翌営業日以降に実施
 * かつ その間に他の稼働記録がない
 * ```
 *
 * ── これは不正の認定ではない ────────────────────────────
 * §1.1。清掃が遅れる理由には、人員の都合・設備の不具合・
 * 販売停止中の客室・記録の入力漏れがある。出すのは
 * **「退室から清掃までに日が空いている」という事実**だけ。
 *
 * ── 「分からない」を「無かった」に倒さない ──────────────
 * §1.2。その間に他の稼働記録があったかは
 * `context.occupancyBetweenCheckOutAndToday` が持つ。**`null`（分からない）
 * のときは差異にしない。** 稼働記録の連携が無い期間に「空室のまま放置
 * された」と読むと、連携が無いことそのものが差異になる。
 *
 * ── 日付は業務日で数える ────────────────────────────────
 * architecture.md §7。`checkOutAt` は時刻（epoch ミリ秒）だが、
 * 「翌営業日以降」は業務日どうしの比較。**業務日への変換は呼び出し側**
 * （施設の日締め時刻を知っているのは engine の外）。ここは
 * `checkOutBusinessDate` を受け取る。
 */

import type { FindingDraft, Rule, RuleContext } from "../types.js";

/** 確信度の基点と、日数ごとの加点（§3.5 は確信度を定めていない）。 */
export const R004_BASE_CONFIDENCE = 45;

/**
 * 空いた日数 1 日あたりの加点と上限。
 *
 * **§3.5 に確信度の式が無い。** R001（§3.2）が「根拠の数 × 加点」で
 * 組み立てているのに倣い、**空いた日数**を根拠の強さとした。
 * 1 日空いただけと 1 週間空いたのを同じ確信度で出さない。
 * 上限は §1.3 の単一シグナル上限（79）より下に置く（根拠は 1 つなので、
 * どのみち `capSingleSignal()` が 79 で止める）。
 */
export const R004_CONFIDENCE_PER_DAY = 8;
export const R004_MAX_CONFIDENCE = 75;

/** アウト清掃の作業種別（PK-SPEC-P1 §2.1）。 */
const CHECKOUT_TASK_TYPE = "CHECKOUT";

/**
 * `YYYY-MM-DD` どうしの日数差。**業務日は text なので数えて出す。**
 *
 * 不正な形なら `null`。**0 を返さない**（「同じ日」と区別できなくなる）。
 */
export function businessDateDiff(from: string, to: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000));
}

export const R004: Rule = {
  code: "R004",
  version: "1.0",
  title: "退室日と清掃日の相違",
  requires: ["occupancy", "observation"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, task, room, businessDate, checkOutBusinessDate } = context;

    if (occupancy === null || occupancy.checkOutAt === null) return null;
    if (checkOutBusinessDate === null) return null;
    // アウト清掃が完了していること。**未完了を「遅れている」と言わない**
    // （まだ当日の作業が終わっていないだけかもしれない）。
    if (task === null || task.taskType !== CHECKOUT_TASK_TYPE || !task.isCompleted) return null;

    // 「翌営業日以降」＝ 退室の業務日より 2 日以上あと。翌日ちょうど（+1）は
    // **通常の運用**（夜に退室 → 翌日清掃）なので差異にしない。
    const gap = businessDateDiff(checkOutBusinessDate, businessDate);
    if (gap === null || gap < 2) return null;

    // **`null`（分からない）は差異にしない**（冒頭の注記）。
    if (context.occupancyBetweenCheckOutAndToday !== false) return null;

    const confidence = Math.min(
      R004_MAX_CONFIDENCE,
      R004_BASE_CONFIDENCE + (gap - 1) * R004_CONFIDENCE_PER_DAY,
    );

    return {
      ruleCode: "R004",
      severity: "MEDIUM",
      confidence,
      title: `${room.number} 号室：退室日と清掃日の相違`,
      summary:
        `退室の記録は ${checkOutBusinessDate} ですが、アウト清掃の記録は ` +
        `${businessDate} です。その間に他の稼働記録はありません。`,
      matchedSignals: ["CLEANING_DELAYED"],
      evidence: {
        occupancy: {
          checkOutAt: occupancy.checkOutAt,
          checkOutBusinessDate,
          isOccupied: occupancy.isOccupied,
          source: occupancy.source,
          importedAt: occupancy.importedAt,
        },
        task: {
          taskType: task.taskType,
          completedAt: task.completedAt,
          businessDate,
        },
        gapDays: gap,
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
