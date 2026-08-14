/**
 * R010 — 客室ステータスの手動上書き頻発（PK-SPEC-P4 §3.8）。**純粋関数。**
 *
 * task: docs/tasks/P4-12.md
 *
 * ```
 * 同一ユーザーが直近 7 日で 5 回以上 READY への手動上書きを実施
 * 確信度: 固定 60
 * 重要度: MEDIUM
 * ```
 *
 * ── これは個人を指摘するものではない（§3.8 の注記 MUST）───
 * §3.8 は「運用手順の問題を示す可能性が高い」と明記し、差異詳細画面に
 * **「業務手順の見直しが必要な可能性があります」を必ず併記する**ことを
 * MUST にしている。`summary` にその文言を入れてあるので、
 * **消さないこと。** 画面（W-07）は `summary` をそのまま出す。
 *
 * ── 氏名を出さない ──────────────────────────────────────
 * security.md §5 / INV-07。`evidence` に載せるのは `membership.id` と
 * 回数だけ。**「誰が」を画面の主語にしない。** 上書きが多いこと自体は
 * 現場の判断であって、評価の対象ではない。
 *
 * ── 施設全体で数え、当日その客室を触った人だけを立てる ───
 * §3.8 の条件は人単位（施設全体で 5 回）だが、差異は客室 × 業務日 ×
 * ルールで 1 件（§2.5 の `uq_finding`）。**その人が当日この客室を
 * 上書きしていること**を条件に足して、差異を置く場所を決めている。
 * 足さないと、施設の全客室に同じ差異が並ぶ。
 */

import type { FindingDraft, Rule, RuleContext, StatusOverrideFact } from "../types.js";

/** 差異にする回数（§3.8「直近 7 日で 5 回以上」）。 */
export const R010_THRESHOLD = 5;

/** §3.8 の「直近 7 日」。**呼び出し側が範囲を絞って渡す。** */
export const R010_WINDOW_DAYS = 7;

/** 確信度（§3.8「固定 60」）。 */
export const R010_CONFIDENCE = 60;

/** §3.8 が数える上書き先。 */
const COUNTED_STATUS = "READY";

/**
 * 上書きした人ごとの件数。**`READY` への上書きだけを数える**（§3.8）。
 *
 * 並びに依存しない（`Map` を返し、判定は件数だけ）。
 */
export function overrideCountsByActor(
  overrides: readonly StatusOverrideFact[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const override of overrides) {
    if (override.toStatus !== COUNTED_STATUS) continue;
    counts.set(override.actorId, (counts.get(override.actorId) ?? 0) + 1);
  }
  return counts;
}

export const R010: Rule = {
  code: "R010",
  version: "1.0",
  title: "客室ステータスの手動上書き頻発",
  // **3 系統のどれも要らない。** 根拠は `auditLog`（§3.1 の「必要系統」も
  // `AuditLog` と書いてある）。`requires` を空にしておかないと、
  // 稼働記録の連携が無い施設で永久に抑制される（§4.1）。
  requires: [],

  evaluate(context: RuleContext): FindingDraft | null {
    const { statusOverrides, room, businessDate } = context;
    if (statusOverrides.length === 0) return null;

    const counts = overrideCountsByActor(statusOverrides);

    // その人が当日この客室を `READY` へ上書きしていること（冒頭の注記）。
    const todayOnThisRoom = statusOverrides.filter(
      (override) => override.roomId === room.id && override.toStatus === COUNTED_STATUS,
    );
    const actor = todayOnThisRoom.find(
      (override) => (counts.get(override.actorId) ?? 0) >= R010_THRESHOLD,
    );
    if (actor === undefined) return null;

    const count = counts.get(actor.actorId) ?? 0;

    return {
      ruleCode: "R010",
      severity: "MEDIUM",
      confidence: R010_CONFIDENCE,
      title: `${room.number} 号室：客室ステータスの手動上書きが続いています`,
      // §3.8 MUST。**この一文を消さないこと。**
      summary:
        `直近 ${String(R010_WINDOW_DAYS)} 日で、同じ担当者による清掃済への手動更新が ` +
        `${String(count)} 件記録されています。` +
        "業務手順の見直しが必要な可能性があります。",
      matchedSignals: ["FREQUENT_STATUS_OVERRIDE"],
      evidence: {
        overrideCount: count,
        windowDays: R010_WINDOW_DAYS,
        businessDate,
        // **氏名を持たない**（security.md §5）。
        actorId: actor.actorId,
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
