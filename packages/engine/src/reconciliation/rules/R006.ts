/**
 * R006 — 稼働記録なしの清掃発生（PK-SPEC-P4 §3.7）。**純粋関数。**
 *
 * task: docs/tasks/P4-04.md
 *
 * ```
 * 当該日の稼働記録が 1 件も無い × 清掃が完了している × 施設は連携あり
 * ```
 *
 * ── 見ているのは現場ではなく連携 ────────────────────────
 * §3.7 の「用途: 連携の欠落・取込漏れの検出」。**現場の作業を疑うルール
 * ではない。** 清掃は実際に行われていて、記録側（PMS / CSV 取込）に
 * その日の行が来ていない、という状態を拾う。文言もそう書く
 * （ui-writing.md §2 の「不正」「疑わしい」を出さない）。
 *
 * ── 施設が連携を持たなければ黙る ────────────────────────
 * `occupancyLinked = false` の施設では稼働記録が無いのが**正常**。
 * §4.1 の抑制（`OCCUPANCY_NOT_LINKED`）は「A 系統を要するルール」に
 * 掛かるが、R006 は A が**無いこと**を見るルールなので `requires` に
 * `occupancy` を入れられない（入れると `SOURCE_UNAVAILABLE` で
 * 常に抑制され、何も検出しない）。そのため条件として自分で見る。
 *
 * ── 必要系統は B ────────────────────────────────────────
 * §3.1 の一覧どおり。観察が 1 件も無い日は評価しない。**「今回は記録
 * しない」を選んだ場合も観察系統はある**（`suppression.ts` の注記）ので、
 * スキップした清掃は評価に入る。
 *
 * ── 確信度は 50 固定 ────────────────────────────────────
 * §3.7 は確信度の式を定めていない（DECISIONS #108）。50 にしてあるのは、
 * 取込の遅延と連携の欠落を**この時点では区別できない**ため。R010 の
 * 固定 60 より低い。翌日の取込で解消する差異を高い確信度で出さない。
 */

import type { FindingDraft, Rule, RuleContext } from "../types.js";

/** §3.7 に式が無いため固定（DECISIONS #108）。 */
export const R006_CONFIDENCE = 50;

export const R006: Rule = {
  code: "R006",
  version: "1.0",
  title: "稼働記録なしの清掃発生",
  requires: ["observation"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, task, property, room } = context;

    // 連携を持たない施設では稼働記録が無いのが正常（§3.7 の 3 つ目の条件）。
    if (!property.occupancyLinked) return null;
    // 稼働記録がある日は対象外。**「空室」の記録があるのは R001 の担当。**
    if (occupancy !== null) return null;
    if (task === null || !task.isCompleted) return null;

    return {
      ruleCode: "R006",
      severity: "MEDIUM",
      confidence: R006_CONFIDENCE,
      title: `${room.number} 号室：稼働記録なしの清掃発生`,
      summary:
        "清掃は完了していますが、この日の稼働記録が取り込まれていません。" +
        "連携の遅れか取込漏れの可能性があります。",
      // **2 つとも事実。** 片方だけでは差異にならない
      //（清掃が無い日に記録が無いのは正常、記録がある日の清掃も正常）。
      matchedSignals: ["OCCUPANCY_MISSING", "CLEANING_COMPLETED"],
      evidence: {
        // §6.2 MUST の「データなし」を画面が出せるように、**欠落を明示して渡す。**
        occupancy: null,
        task: {
          taskType: task.taskType,
          isCompleted: true,
          completedAt: task.completedAt,
        },
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
