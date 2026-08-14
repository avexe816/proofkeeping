/**
 * R005 — 連泊記録と現場の相違（PK-SPEC-P4 §3.6）。**純粋関数。**
 *
 * task: docs/tasks/P4-11.md
 *
 * ```
 * occupancy.isStayover = true
 * かつ observation.bedsUsed = 0
 * かつ observation.trashLevel = NONE
 * かつ 上記が 2 日連続
 * ```
 *
 * ── これは不正の認定ではない ────────────────────────────
 * §1.1。連泊の記録があるのに使用の痕跡が無い理由には、外泊・早期の
 * 実質退去・記録の取消漏れがある。出すのは**「連泊の記録と現場の記録が
 * 食い違っている」という事実**だけ。
 *
 * ── 「2 日連続」を 1 日で名乗らない ─────────────────────
 * §3.6 の条件は 4 つで、4 つめが「上記が 2 日連続」。**前日の観察と
 * 前日の稼働記録の両方が要る。** 片方でも欠けていたら差異にしない
 * （§1.2。分からないものを「該当した」側に倒さない）。
 *
 * ── 記録しなかったことを差異にしない ────────────────────
 * PK-SPEC-P3 §1.3。`skipped` の日は「0 台使われていた」ではない。
 * 前日・当日のどちらかがスキップなら差異にしない。
 */

import type { FindingDraft, ObservationFact, Rule, RuleContext } from "../types.js";

/** 確信度の基点（§3.6 は確信度を定めていない）。 */
export const R005_BASE_CONFIDENCE = 55;

/**
 * 3 泊目以降の加点。
 *
 * **§3.6 に確信度の式が無い。** 2 日連続で痕跡が無いことが条件そのものなので、
 * それを超えて連泊が続くほど食い違いが大きい、という 1 点だけを加点にした。
 * 上限は §1.3 の単一シグナル上限（79）が別に掛かる。
 */
export const R005_LONG_STAY_BONUS = 10;

/** 「使用の痕跡が無い」と読む状態（§3.6 の 2 条件）。 */
export function hasNoTrace(observation: ObservationFact | null): boolean {
  if (observation === null || observation.skipped) return false;
  return observation.bedsUsed === 0 && observation.trashLevel === "NONE";
}

export const R005: Rule = {
  code: "R005",
  version: "1.0",
  title: "連泊記録と現場の相違",
  requires: ["occupancy", "observation"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, observation, previousObservation, previousOccupancy, room } = context;

    if (occupancy === null || !occupancy.isStayover) return null;
    if (!hasNoTrace(observation)) return null;

    // 「2 日連続」。**前日も連泊で、前日も痕跡が無かったこと。**
    if (previousOccupancy === null || !previousOccupancy.isStayover) return null;
    if (!hasNoTrace(previousObservation)) return null;

    const nightIndex = occupancy.nightIndex;
    const confidence =
      R005_BASE_CONFIDENCE + (nightIndex !== null && nightIndex >= 3 ? R005_LONG_STAY_BONUS : 0);

    return {
      ruleCode: "R005",
      severity: "MEDIUM",
      confidence,
      title: `${room.number} 号室：連泊記録と現場の相違`,
      summary:
        "連泊の記録がありますが、ベッドの使用とゴミの記録が 2 日続けて " +
        "ありません。稼働記録の取消漏れの可能性があります。",
      // **根拠は 2 つ**（当日と前日）。単一シグナルの上限（§1.3）に掛からない。
      matchedSignals: ["NO_TRACE_TODAY", "NO_TRACE_PREVIOUS_DAY"],
      evidence: {
        occupancy: {
          isOccupied: occupancy.isOccupied,
          isStayover: occupancy.isStayover,
          nightIndex: occupancy.nightIndex,
          nightsTotal: occupancy.nightsTotal,
          guestCount: occupancy.guestCount,
          source: occupancy.source,
          importedAt: occupancy.importedAt,
        },
        observation:
          observation === null
            ? null
            : {
                bedsUsed: observation.bedsUsed,
                trashLevel: observation.trashLevel,
                recordedAt: observation.recordedAt,
                recordedById: observation.recordedById,
                usedDefaults: observation.usedDefaults,
              },
        previousObservation:
          previousObservation === null
            ? null
            : {
                bedsUsed: previousObservation.bedsUsed,
                trashLevel: previousObservation.trashLevel,
                recordedAt: previousObservation.recordedAt,
              },
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
