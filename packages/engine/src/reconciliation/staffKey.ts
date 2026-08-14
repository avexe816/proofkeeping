/**
 * スタッフキーの除外と `actorType` 不明の扱い（PK-SPEC-P6 §4.3 / §4.4）。
 * **純粋関数。**
 *
 * task: docs/tasks/P6-08.md
 *
 * ── なぜルールの外に置くか ──────────────────────────────
 * §4.3 / §4.4 は R002（§3.3）と R013（§3.9）の両方に等しく掛かる。
 * どちらのファイルにも同じ 20 行を書くと、片方だけ直した状態が作れる。
 * `confidence.ts` を全ルール共通の調整置き場にしたのと同じ理由で、
 * **2 ルールに共通する部分だけをここへ出す。**
 *
 * ── 「方法 2 を既定とする」（§4.4 MUST）────────────────
 * 清掃スタッフの入室は正常な業務なので、解錠の記録から外す。§4.4 は
 * 3 つの方法を挙げたうえで、**清掃タスクの start / complete 時刻の
 * 前後 10 分による除外を既定と定めている。**
 *
 *   方法1（`actorType` で外す）だけでは、鍵の種別を返さない機種で
 *   何も外れない。**外れないと、清掃のたびに R002 が立つ。**
 *   方法3（スタッフカード ID を登録）は運用の手間が要り、カードを
 *   1 枚登録し忘れるだけで穴が空く。
 *
 * 方法 1 は方法 2 と両立するので、両方を掛ける（`STAFF_KEY` /
 * `MASTER_KEY` は窓の外でも外す）。
 *
 * ── 「不明を推測で埋めない」（§4.3 MUST / P6-08 の完了条件）──
 * `actorType` が無い解錠を `GUEST_KEY` とみなさない。**宿泊者の鍵と
 * 同じ扱いで数えるが、「宿泊者の鍵だった」とは記録しない。**
 * 数えたうえで確信度を 25 下げ、根拠に `actorTypeUnknown` を残す。
 * W-07（差異詳細）はそれを見て「鍵の種別は取得できていません」と出す。
 *
 * 逆に、不明を**数えない**選択も一見安全に見えるが、それは
 * 「鍵の種別を返さない機種では R002 / R013 が一度も立たない」ことを
 * 意味する。§4.3 が confidence の減点を定めているのは、**不明でも
 * 立てたうえで弱く出す**ことを求めているからで、数えない実装は
 * 減点の規定と両立しない。
 */

import type { SignalFact, TaskFact } from "./types.js";

/** 清掃スタッフの鍵とみなす種別（§4.4 の方法 1）。 */
export const STAFF_ACTOR_TYPES: ReadonlySet<string> = new Set(["STAFF_KEY", "MASTER_KEY"]);

/** 清掃タスクの start / complete の前後何分を除外するか（§4.4 の方法 2）。 */
export const CLEANING_WINDOW_MINUTES = 10;

/** ミリ秒に直したもの。 */
export const CLEANING_WINDOW_MS = CLEANING_WINDOW_MINUTES * 60 * 1000;

/** `actorType` が取得できていないか（§4.3）。**省略と `UNKNOWN` を区別しない。** */
export function isActorTypeUnknown(signal: SignalFact): boolean {
  return signal.actorType === null || signal.actorType === "UNKNOWN";
}

/** 清掃スタッフの鍵か（§4.4 の方法 1）。**不明はここでは偽**（別に扱う）。 */
export function isStaffActor(signal: SignalFact): boolean {
  return signal.actorType !== null && STAFF_ACTOR_TYPES.has(signal.actorType);
}

/**
 * 清掃の前後 10 分に落ちているか（§4.4 の方法 2）。
 *
 * **窓は両端を含む。** ちょうど 10 分前の解錠を外す側に倒す。§4.4 の
 * 目的は清掃スタッフの入室を差異にしないことで、境界の 1 件を差異に
 * 寄せる理由が無い（誤検知を減らす方向に倒す / PK-SPEC-P4 §11）。
 *
 * `task` が `null`、あるいは start も complete も無ければ**常に偽**。
 * 清掃されていない客室の解錠は、外す根拠が無い。
 */
export function isWithinCleaningWindow(signal: SignalFact, task: TaskFact | null): boolean {
  if (task === null) return false;
  for (const at of [task.startedAt, task.completedAt]) {
    if (at === null) continue;
    if (Math.abs(signal.occurredAt - at) <= CLEANING_WINDOW_MS) return true;
  }
  return false;
}

/**
 * 清掃スタッフによる入室とみなせる解錠を外す（§4.4）。
 *
 * 外すのは 2 つ。**`STAFF_KEY` / `MASTER_KEY`（方法 1）と、清掃の前後
 * 10 分に落ちた解錠（方法 2）。** 並びは入力順のまま
 * （PK-SPEC-P4 §10.1 の決定性）。
 */
export function excludeStaffAccess(
  signals: readonly SignalFact[],
  task: TaskFact | null,
): SignalFact[] {
  return signals.filter(
    (signal) => !isStaffActor(signal) && !isWithinCleaningWindow(signal, task),
  );
}

/** `actorType` 不明の解錠が混ざっているときの減点（§4.3）。 */
export const UNKNOWN_ACTOR_CONFIDENCE_PENALTY = -25;

/**
 * 不明が 1 件でもあれば減点する（§4.3）。
 *
 * **件数に比例させない。** §4.3 は「25 減じる」であって、不明 1 件あたり
 * ではない。比例させると 4 件で 0 になり、根拠が増えるほど確信度が
 * 下がるという逆立ちした挙動になる。
 */
export function unknownActorPenalty(signals: readonly SignalFact[]): number {
  return signals.some(isActorTypeUnknown) ? UNKNOWN_ACTOR_CONFIDENCE_PENALTY : 0;
}
