/**
 * R014 — 稼働記録の事後変更（PK-SPEC-P4 §3.10）。**純粋関数。**
 *
 * task: docs/tasks/P4-12.md
 *
 * ```
 * 同一 (roomId, businessDate) の OccupancySnapshot が
 * 清掃完了後に isOccupied = true → false へ変更された
 *
 * 用途: PMS 側での記録取消の検出
 * ```
 *
 * ── これは不正の認定ではない ────────────────────────────
 * §1.1。取消には、予約のキャンセル処理・部屋替え・入力の訂正がある。
 * 出すのは**「清掃が終わったあとで稼働記録が取り消された」という事実**だけ。
 *
 * ── 変更履歴は監査ログにしか無い ────────────────────────
 * `occupancySnapshot` は上書き方式（§8.1 MUST）で、前の値を残さない。
 * 唯一の記録は `auditLog`（`occupancy.imported` の `changes`）。
 * **その照合は呼び出し側が行い、結果だけを渡す**
 * （`context.occupancyRevokedAfterCleaning`）。engine は DB を引かない（§9 MUST）。
 *
 * ── 「分からない」を差異にしない ────────────────────────
 * §1.2。`null` は「監査ログを確かめていない」であって
 * 「取り消されていない」ではない。
 */

import type { FindingDraft, Rule, RuleContext } from "../types.js";

/** 確信度（§3.10 は値を定めていない）。 */
export const R014_BASE_CONFIDENCE = 60;

export const R014: Rule = {
  code: "R014",
  version: "1.0",
  title: "稼働記録の事後変更",
  requires: ["occupancy"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancyRevokedAfterCleaning, occupancy, room, businessDate } = context;
    if (occupancyRevokedAfterCleaning === null) return null;

    const { at, cleaningCompletedAt } = occupancyRevokedAfterCleaning;
    // **清掃完了より後の変更だけ。** 呼び出し側でも絞るが、ルール単体で
    // 呼んでも同じ結論になるようにする（R001 と同じ方針）。
    if (at <= cleaningCompletedAt) return null;

    return {
      ruleCode: "R014",
      severity: "MEDIUM",
      confidence: R014_BASE_CONFIDENCE,
      title: `${room.number} 号室：稼働記録の事後変更`,
      summary:
        "清掃の記録が確定したあとで、稼働記録が「稼働」から「空室」へ" +
        "変更されています。連携元での取消の可能性があります。",
      matchedSignals: ["OCCUPANCY_REVOKED_AFTER_CLEANING"],
      evidence: {
        businessDate,
        revokedAt: at,
        cleaningCompletedAt,
        occupancy:
          occupancy === null
            ? null
            : {
                isOccupied: occupancy.isOccupied,
                source: occupancy.source,
                importedAt: occupancy.importedAt,
              },
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
