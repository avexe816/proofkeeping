/**
 * R013 — 深夜帯の施錠解除（PK-SPEC-P4 §3.9）。**純粋関数。**
 *
 * task: docs/tasks/P4-12.md
 *
 * ```
 * 0:00-5:00 に GUEST_KEY による DOOR_UNLOCK
 * かつ occupancy.isOccupied = false
 * かつ RoomAccessLog なし
 * ```
 *
 * ── R002 との違い ───────────────────────────────────────
 * R002（§3.3）は**回数**（2 回以上）を見る HIGH のルール。R013 は
 * **1 回でも深夜帯なら**立てる MEDIUM のルール。両方の条件を満たす日は
 * 2 件出る。**統合しない**（§3.3 MUST が統合を求めているのは R001 と
 * R002 の組だけで、R013 は含まれていない）。
 *
 * ── `MOBILE_KEY` を含めない ─────────────────────────────
 * §3.9 は `GUEST_KEY` だけを名指ししている。R002（§3.3）は
 * 「GUEST_KEY / MOBILE_KEY」と書き分けているので、**書き分けをそのまま写す。**
 * 揃えたくなるが、仕様の 2 か所が別々に書いている以上、片方に寄せるのは
 * 推測になる。
 */

import {
  excludeStaffAccess,
  isActorTypeUnknown,
  unknownActorPenalty,
} from "../staffKey.js";
import type { FindingDraft, Rule, RuleContext, SignalFact, TaskFact } from "../types.js";

import { isLateNight } from "./R002.js";

/** 確信度（§3.9 は値を定めていない）。**根拠は 1 つなので単一シグナル扱い。** */
export const R013_BASE_CONFIDENCE = 55;

/**
 * 深夜帯の、宿泊者鍵または種別不明による解錠（PK-SPEC-P6 §4.3）。
 *
 * **`MOBILE_KEY` は入らない。** §3.9 は `GUEST_KEY` だけを名指しして
 * おり、R002（§3.3）との書き分けをそのまま写している（上の注記）。
 * 不明を足すのは §4.3 が R013 にも減点を定めているからで、
 * **不明を `GUEST_KEY` とみなしたわけではない。**
 *
 * 並びは入力順のまま（§10.1 の決定性）。
 */
export function lateNightGuestUnlocksOf(signals: readonly SignalFact[]): SignalFact[] {
  return signals.filter(
    (signal) =>
      signal.signalType === "DOOR_UNLOCK" &&
      (signal.actorType === "GUEST_KEY" || isActorTypeUnknown(signal)) &&
      isLateNight(signal),
  );
}

/** 清掃スタッフの入室を外したうえで、深夜帯の解錠を取る（§4.4）。 */
export function candidateLateNightUnlocksOf(
  signals: readonly SignalFact[],
  task: TaskFact | null,
): SignalFact[] {
  return lateNightGuestUnlocksOf(excludeStaffAccess(signals, task));
}

export const R013: Rule = {
  code: "R013",
  version: "1.0",
  title: "深夜帯の施錠解除",
  requires: ["occupancy", "signal"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, signals, room, accessLogs, task } = context;

    if (occupancy === null || occupancy.isOccupied) return null;
    if (occupancy.isHouseUse || occupancy.isComplimentary) return null;
    if (room.saleStatus === "MAINTENANCE" || room.saleStatus === "OUT_OF_ORDER") return null;
    if (accessLogs.length > 0) return null;

    const unlocks = candidateLateNightUnlocksOf(signals, task);
    if (unlocks.length === 0) return null;

    const actorTypeUnknown = unlocks.some(isActorTypeUnknown);

    return {
      ruleCode: "R013",
      severity: "MEDIUM",
      // §4.3: `actorType` が取得できない場合は confidence を 25 減じる。
      confidence: R013_BASE_CONFIDENCE + unknownActorPenalty(unlocks),
      title: `${room.number} 号室：深夜帯の施錠解除`,
      summary:
        `稼働記録では空室ですが、深夜帯（0 時〜5 時）に清掃時間帯を除く解錠が ` +
        `${String(unlocks.length)} 回記録されています。`,
      matchedSignals: ["LATE_NIGHT_GUEST_UNLOCK"],
      evidence: {
        occupancy: {
          isOccupied: occupancy.isOccupied,
          source: occupancy.source,
          importedAt: occupancy.importedAt,
        },
        signals: unlocks.map((signal) => ({
          signalType: signal.signalType,
          occurredAt: signal.occurredAt,
          actorType: signal.actorType,
          localHour: signal.localHour,
        })),
        /** §4.3: 画面に「鍵の種別は取得できていません」と明示するための旗。 */
        actorTypeUnknown,
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
