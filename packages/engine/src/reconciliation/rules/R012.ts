/**
 * R012 — 写真未添付での完了（PK-SPEC-P4 §3.1）。**純粋関数。**
 *
 * task: docs/tasks/P4-12.md
 *
 * ── 仕様に条件の記述が無い ──────────────────────────────
 * §3 は R001〜R006 / R010 / R013 / R014 の条件だけを書いており、
 * **R012 は §3.1 の一覧（名称・重要度 LOW・必要系統 task）にしか無い。**
 * ただし「写真未添付での完了」は名称そのものが条件を言い切っている
 * （完了した清掃に写真が 1 枚も無い）ので、閾値を決める余地が無い。
 * **推測の入る余地が無いものだけを実装した。** 数値の閾値が要る
 * R007 / R008 / R009 / R011 は実装していない（OPEN_QUESTIONS #066）。
 *
 * ── これは個人を指摘するものではない ────────────────────
 * §1.1 / security.md §5。写真が無い理由には、端末の不調・電波・
 * 施設ごとの運用（写真を必須にしていない）がある。**重要度は LOW。**
 * 出すのは「証跡が薄い」という事実だけで、作業の良し悪しではない。
 */

import type { FindingDraft, Rule, RuleContext } from "../types.js";

/** 確信度。**事実そのものなので確信度は高いが、重要度は LOW。** */
export const R012_CONFIDENCE = 70;

export const R012: Rule = {
  code: "R012",
  version: "1.0",
  title: "写真未添付での完了",
  // §3.1 の必要系統は `task`。3 系統のどれも要らない。
  requires: [],

  evaluate(context: RuleContext): FindingDraft | null {
    const { task, room, businessDate } = context;
    if (task === null || !task.isCompleted) return null;
    if (task.photoCount > 0) return null;

    return {
      ruleCode: "R012",
      severity: "LOW",
      confidence: R012_CONFIDENCE,
      title: `${room.number} 号室：写真のない完了記録`,
      summary:
        "清掃の完了が記録されていますが、写真が 1 枚もありません。" +
        "あとから客室の状態を確かめられない記録になっています。",
      matchedSignals: ["NO_PHOTO_ON_COMPLETION"],
      evidence: {
        businessDate,
        task: {
          taskType: task.taskType,
          completedAt: task.completedAt,
          photoCount: task.photoCount,
        },
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
