/**
 * R002 — 施錠解除と稼働記録の不一致（PK-SPEC-P4 §3.3）。**純粋関数。**
 *
 * task: docs/tasks/P4-12.md
 *
 * ```
 * occupancy.isOccupied = false
 * かつ GUEST_KEY / MOBILE_KEY による DOOR_UNLOCK が 2 回以上
 * かつ その時刻に RoomAccessLog がない
 * かつ STAFF_KEY / MASTER_KEY のみではない
 * ```
 *
 * ── これは不正の認定ではない ────────────────────────────
 * §1.1。解錠には、鍵の再発行・設備点検・誤った部屋への入室・
 * 機器の誤検出がある。出すのは**「解錠の記録と稼働記録が食い違っている」
 * という事実**だけ。
 *
 * ── R001 との統合はここではない ─────────────────────────
 * §3.3 MUST「R001 と R002 が同一客室・同一業務日で同時に発生した場合、
 * 2 件を別々に出さず、R002 に統合する」。**統合は `evaluate()` が行う**
 * （`mergeR001IntoR002()`）。ルールは自分の条件だけを見る。
 * ここで R001 を呼ぶと、ルールどうしが依存して registry の並びに
 * 意味が生まれる。
 *
 * ── 「その時刻に RoomAccessLog がない」──────────────────
 * 入室記録があればそもそも `suppression.ts` が全ルールを抑える（§4.1）。
 * それでも早期 return を残すのは、**ルール単体で呼んでも同じ結論に
 * なるようにするため**（R001 と同じ方針）。
 */

import type { FindingDraft, Rule, RuleContext, SignalFact } from "../types.js";

/** 宿泊者の鍵とみなす種別（§3.3）。 */
const GUEST_ACTOR_TYPES: ReadonlySet<string> = new Set(["GUEST_KEY", "MOBILE_KEY"]);

/** 差異にする最小の解錠回数（§3.3）。 */
export const R002_MIN_UNLOCKS = 2;

/** 確信度の基点と加点（§3.3）。 */
export const R002_BASE_CONFIDENCE = 50;
export const R002_MANY_UNLOCKS_BONUS = 20;
export const R002_LATE_NIGHT_BONUS = 15;
/** 観察でも使用痕跡があるとき（R001 と同時発生）の加点（§3.3）。 */
export const R002_OBSERVATION_BONUS = 25;

/** 「解錠回数が 4 回以上なら +20」（§3.3）。 */
export const R002_MANY_UNLOCKS_THRESHOLD = 4;

/** 深夜帯（§3.3 / §3.9 の「0:00-5:00」）。**終端は含まない。** */
export const LATE_NIGHT_FROM_HOUR = 0;
export const LATE_NIGHT_TO_HOUR = 5;

/** 施設の地域時刻で深夜帯か。**`localHour` が無ければ偽**（推測しない）。 */
export function isLateNight(signal: SignalFact): boolean {
  const hour = signal.localHour;
  if (hour === null) return false;
  return hour >= LATE_NIGHT_FROM_HOUR && hour < LATE_NIGHT_TO_HOUR;
}

/** 宿泊者の鍵による解錠。**並びは入力順のまま**（§10.1 の決定性）。 */
export function guestUnlocksOf(signals: readonly SignalFact[]): SignalFact[] {
  return signals.filter(
    (signal) =>
      signal.signalType === "DOOR_UNLOCK" &&
      signal.actorType !== null &&
      GUEST_ACTOR_TYPES.has(signal.actorType),
  );
}

export const R002: Rule = {
  code: "R002",
  version: "1.0",
  title: "施錠解除と稼働記録の不一致",
  requires: ["occupancy", "signal"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, signals, room, accessLogs } = context;

    if (occupancy === null || occupancy.isOccupied) return null;
    if (occupancy.isHouseUse || occupancy.isComplimentary) return null;
    if (room.saleStatus === "MAINTENANCE" || room.saleStatus === "OUT_OF_ORDER") return null;
    if (accessLogs.length > 0) return null; // 正当な入室が登録済み

    // 「STAFF_KEY / MASTER_KEY のみではない」は、宿泊者の鍵の解錠を数えれば足りる。
    const unlocks = guestUnlocksOf(signals);
    if (unlocks.length < R002_MIN_UNLOCKS) return null;

    const lateNight = unlocks.some(isLateNight);

    let confidence = R002_BASE_CONFIDENCE;
    if (unlocks.length >= R002_MANY_UNLOCKS_THRESHOLD) confidence += R002_MANY_UNLOCKS_BONUS;
    if (lateNight) confidence += R002_LATE_NIGHT_BONUS;

    const matchedSignals = ["GUEST_KEY_UNLOCK"];
    if (lateNight) matchedSignals.push("LATE_NIGHT_UNLOCK");

    return {
      ruleCode: "R002",
      severity: "HIGH",
      confidence,
      title: `${room.number} 号室：施錠解除と稼働記録の不一致`,
      summary:
        `稼働記録では空室ですが、宿泊者の鍵による解錠が ` +
        `${String(unlocks.length)} 回記録されています。`,
      matchedSignals,
      evidence: {
        occupancy: {
          isOccupied: occupancy.isOccupied,
          reservationRef: occupancy.reservationRef,
          guestCount: occupancy.guestCount,
          source: occupancy.source,
          importedAt: occupancy.importedAt,
        },
        signals: unlocks.map((signal) => ({
          signalType: signal.signalType,
          occurredAt: signal.occurredAt,
          actorType: signal.actorType,
          localHour: signal.localHour,
        })),
        unlockCount: unlocks.length,
        lateNight,
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
