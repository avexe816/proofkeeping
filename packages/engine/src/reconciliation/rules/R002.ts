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
 *
 * ── P6-08 で変わったこと（PK-SPEC-P6 §4.3 / §4.4）───────
 * ① **清掃タスクの前後 10 分の解錠を外す**（§4.4 MUST の「方法 2 を
 *    既定とする」）。清掃スタッフの入室は正常な業務で、外さないと
 *    清掃のたびに差異が立つ。
 * ② **`actorType` 不明の解錠を数に入れ、確信度を 25 下げる**（§4.3）。
 *    多くのロックは「誰が開けたか」を返さない。数えない実装にすると、
 *    そういう機種では R002 が一度も立たない。**不明を `GUEST_KEY` と
 *    みなすのではなく、不明のまま弱く出す。**
 * どちらも `../staffKey.ts` に置いてある（R013 と共通）。
 */

import {
  excludeStaffAccess,
  isActorTypeUnknown,
  unknownActorPenalty,
} from "../staffKey.js";
import type { FindingDraft, Rule, RuleContext, SignalFact, TaskFact } from "../types.js";

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

/**
 * 宿泊者の鍵、または種別不明による解錠（PK-SPEC-P6 §4.3）。
 *
 * **`STAFF_KEY` / `MASTER_KEY` は入らない。** §3.3 の「STAFF_KEY /
 * MASTER_KEY のみではない」は、この絞り込みで満たされる。
 *
 * 並びは入力順のまま（§10.1 の決定性）。
 */
export function guestUnlocksOf(signals: readonly SignalFact[]): SignalFact[] {
  return signals.filter(
    (signal) =>
      signal.signalType === "DOOR_UNLOCK" &&
      (isActorTypeUnknown(signal) ||
        (signal.actorType !== null && GUEST_ACTOR_TYPES.has(signal.actorType))),
  );
}

/**
 * 清掃スタッフの入室を外したうえで、宿泊者の鍵・種別不明の解錠を取る。
 *
 * **除外を先に掛ける。** 後に掛けても結果は同じだが、順序を固定して
 * おくと「何を数えているか」が 1 行で読める。
 */
export function candidateUnlocksOf(
  signals: readonly SignalFact[],
  task: TaskFact | null,
): SignalFact[] {
  return guestUnlocksOf(excludeStaffAccess(signals, task));
}

export const R002: Rule = {
  code: "R002",
  version: "1.0",
  title: "施錠解除と稼働記録の不一致",
  requires: ["occupancy", "signal"],

  evaluate(context: RuleContext): FindingDraft | null {
    const { occupancy, signals, room, accessLogs, task } = context;

    if (occupancy === null || occupancy.isOccupied) return null;
    if (occupancy.isHouseUse || occupancy.isComplimentary) return null;
    if (room.saleStatus === "MAINTENANCE" || room.saleStatus === "OUT_OF_ORDER") return null;
    if (accessLogs.length > 0) return null; // 正当な入室が登録済み

    // 清掃スタッフの入室を外し（§4.4）、宿泊者の鍵・種別不明の解錠を数える。
    const unlocks = candidateUnlocksOf(signals, task);
    if (unlocks.length < R002_MIN_UNLOCKS) return null;

    const lateNight = unlocks.some(isLateNight);
    // **不明のまま数えた解錠が混ざっているか**（§4.3）。W-07 が
    // 「鍵の種別は取得できていません」を出す判断もこれを見る。
    const actorTypeUnknown = unlocks.some(isActorTypeUnknown);

    let confidence = R002_BASE_CONFIDENCE;
    if (unlocks.length >= R002_MANY_UNLOCKS_THRESHOLD) confidence += R002_MANY_UNLOCKS_BONUS;
    if (lateNight) confidence += R002_LATE_NIGHT_BONUS;
    // §4.3: `actorType` が取得できない場合は confidence を 25 減じる。
    confidence += unknownActorPenalty(unlocks);

    // **`matchedSignals` に不明を足さない。** ここの件数は §1.3 の
    // 「単一シグナルで 80 以上を出さない」を解く鍵で、足すと
    // *不明であることが確信度の上限を上げる*という逆立ちが起きる。
    const matchedSignals = ["GUEST_KEY_UNLOCK"];
    if (lateNight) matchedSignals.push("LATE_NIGHT_UNLOCK");

    return {
      ruleCode: "R002",
      severity: "HIGH",
      confidence,
      title: `${room.number} 号室：施錠解除と稼働記録の不一致`,
      summary:
        `稼働記録では空室ですが、清掃時間帯を除く解錠が ` +
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
        /** §4.3: 画面に「鍵の種別は取得できていません」と明示するための旗。 */
        actorTypeUnknown,
        room: { number: room.number, saleStatus: room.saleStatus },
      },
    };
  },
};
