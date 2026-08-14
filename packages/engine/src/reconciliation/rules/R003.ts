/**
 * R003 — 人数とリネン消費の相違（PK-SPEC-P4 §3.4）。**純粋関数。**
 *
 * task: docs/tasks/P4-11.md
 *
 * ```
 * baseline.isReliable = true
 * かつ observation.bathTowelUsed > baseline.p90 + 1
 * かつ occupancy.guestCount が記録されている
 * ```
 *
 * ── これは不正の認定ではない ────────────────────────────
 * §1.1。タオルが多いことには、備品の補充漏れ・前日分の残り・
 * 清掃手順の違いなど多様な原因がある。出すのは
 * **「記録された人数に対して消費が基準を超えている」という事実**だけ。
 *
 * ── 信頼できないベースラインを使わない ──────────────────
 * PK-SPEC-P3 §2.4 MUST。`isReliable = false` の統計で差異を出すと、
 * サンプルが数件しか無い組み合わせで毎日差異が立つ。**呼び出し側でも
 * 絞るが、ここでも見る**（ルール単体で呼んでも同じ結論になるように）。
 *
 * ── 連泊は確信度を下げる（§3.4 MUST）───────────────────
 * 連泊では前日分の未回収が混ざりうる。仕様の加点は「連泊でないなら +10」で、
 * **連泊のときに加点しない**ことがそのまま「下げる」に当たる。
 * 連泊を差異から外してはいない（下げるだけ）。
 */

import type { BaselineFact, FindingDraft, Rule, RuleContext } from "../types.js";

/** 基準を超えたと読む余裕（§3.4 の `p90 + 1`）。 */
export const R003_TOLERANCE = 1;

/** 確信度の基点と加点（§3.4）。 */
export const R003_BASE_CONFIDENCE = 40;
export const R003_LARGE_EXCESS_BONUS = 25;
export const R003_MULTI_ITEM_BONUS = 20;
export const R003_NOT_STAYOVER_BONUS = 10;

/** 「超過幅が p90 の 1.5 倍以上」（§3.4）。 */
export const R003_LARGE_EXCESS_RATIO = 1.5;

/**
 * 観察の品目コード → 実測値。
 *
 * **`amenitiesUsed` を混ぜない。** R003 が見るのはリネン（§3.1 の
 * 「人数とリネン消費の相違」）で、アメニティは R008 の担当。
 */
export function linenUsageOf(observation: {
  bathTowelUsed: number;
  faceTowelUsed: number;
  handTowelUsed: number;
  bathMatUsed: number;
}): Readonly<Record<string, number>> {
  return {
    BATH_TOWEL: observation.bathTowelUsed,
    FACE_TOWEL: observation.faceTowelUsed,
    HAND_TOWEL: observation.handTowelUsed,
    BATH_MAT: observation.bathMatUsed,
  };
}

/** 基準を超えた 1 品目。 */
export interface LinenExcess {
  itemCode: string;
  used: number;
  p90Qty: number;
  /** 超過幅（`used - p90Qty`）。 */
  excess: number;
}

/**
 * 基準を超えた品目を並べる。**並びは `linenUsageOf()` の宣言順で固定。**
 *
 * §10.1 の決定性のため、`Object.keys()` の順に依存する数え方をしない
 * （オブジェクトリテラルの順は宣言順なので、ここは決まっている）。
 */
export function excessItemsOf(
  usage: Readonly<Record<string, number>>,
  baselines: readonly BaselineFact[],
): LinenExcess[] {
  const excesses: LinenExcess[] = [];
  for (const [itemCode, used] of Object.entries(usage)) {
    const baseline = baselines.find((row) => row.itemCode === itemCode);
    // **信頼できない統計は無かったことにする**（差異の根拠にしない）。
    if (baseline === undefined || !baseline.isReliable) continue;
    if (used > baseline.p90Qty + R003_TOLERANCE) {
      excesses.push({ itemCode, used, p90Qty: baseline.p90Qty, excess: used - baseline.p90Qty });
    }
  }
  return excesses;
}

export const R003: Rule = {
  code: "R003",
  version: "1.0",
  title: "人数とリネン消費の相違",
  requires: ["occupancy", "observation"],
  requiresBaseline: true,

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, observation, room, baselines } = context;

    if (occupancy === null || observation === null || observation.skipped) return null;
    // §3.4「occupancy.guestCount が記録されている」。**0 人は「記録された 0」**で、
    // 記録が無いこととは違う。稼働していない日は R001 の担当。
    if (!occupancy.isOccupied) return null;

    const usage = linenUsageOf(observation);
    const excesses = excessItemsOf(usage, baselines);
    // §3.4 の条件はバスタオルを名指ししている。**バスタオルが超えていなければ
    // 差異にしない**（他の品目だけの超過は R009 の担当）。
    const bathTowel = excesses.find((row) => row.itemCode === "BATH_TOWEL");
    if (bathTowel === undefined) return null;

    let confidence = R003_BASE_CONFIDENCE;
    // 「超過幅が p90 の 1.5 倍以上」。**p90 が 0 のときは比を取らない**
    // （0 除算で常に加点する形にしない）。
    if (bathTowel.p90Qty > 0 && bathTowel.excess >= bathTowel.p90Qty * R003_LARGE_EXCESS_RATIO) {
      confidence += R003_LARGE_EXCESS_BONUS;
    }
    if (excesses.length >= 2) confidence += R003_MULTI_ITEM_BONUS;
    // §3.4 MUST。**連泊では加点しない**（前日分の未回収が混ざりうる）。
    if (!occupancy.isStayover) confidence += R003_NOT_STAYOVER_BONUS;

    return {
      ruleCode: "R003",
      severity: "MEDIUM",
      confidence,
      title: `${room.number} 号室：人数とリネン消費の相違`,
      summary:
        `記録された人数は ${String(occupancy.guestCount)} 名ですが、` +
        `${String(excesses.length)} 品目が通常の範囲（上位 10% の水準）を超えています。`,
      matchedSignals: excesses.map((row) => `EXCESS_${row.itemCode}`),
      evidence: {
        occupancy: {
          isOccupied: occupancy.isOccupied,
          guestCount: occupancy.guestCount,
          isStayover: occupancy.isStayover,
          source: occupancy.source,
          importedAt: occupancy.importedAt,
        },
        observation: {
          bathTowelUsed: observation.bathTowelUsed,
          faceTowelUsed: observation.faceTowelUsed,
          handTowelUsed: observation.handTowelUsed,
          bathMatUsed: observation.bathMatUsed,
          recordedAt: observation.recordedAt,
          recordedById: observation.recordedById,
          usedDefaults: observation.usedDefaults,
        },
        baseline: excesses.map((row) => ({
          itemCode: row.itemCode,
          used: row.used,
          p90Qty: row.p90Qty,
        })),
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
