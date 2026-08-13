/**
 * 客室ステータスの同期規則（PK-SPEC-P1 §11.1）。**純粋関数。**
 *
 * task: docs/tasks/P1-16.md
 *
 * ── なぜ表をここへ置くのか ──────────────────────────────
 * §11.1 は「タスクの状態変化 → `Room.housekeepingStatus`」の対応表で、
 * 見た目ではなく**業務の規則。** 遷移の実行側（`lib/task/transition.ts`）に
 * `if (action === "start")` を散らすと、客室の状態がどう決まるかが
 * コードから読めなくなり、P2 の検査フローが同じ判断を別の場所で
 * やり直すことになる。`taskStatus.ts` と同じ理由で 1 か所に閉じる。
 *
 * ── READY になるのは検査が終わってから ──────────────────
 * §11.1 の MUST。`complete` は施設が検査を要求するなら `INSPECTING` で
 * 止まる。**検査不要の施設だけが `complete` で `READY` へ進む。**
 * この分岐を呼び出し側の都合で外さないこと。
 */

import type { TaskAction } from "./taskStatus.js";

/**
 * 客室の清掃ステータス（§11.1 の右列）。
 *
 * `packages/db` の `HOUSEKEEPING_STATUSES` と同じ語彙（依存はさせない。
 * `TASK_STATUS_VALUES` と同じ方針）。**永続データなので綴りを変えないこと。**
 */
export const HOUSEKEEPING_STATUS_VALUES = [
  "DIRTY",
  "IN_PROGRESS",
  "INSPECTING",
  "READY",
  "BLOCKED",
] as const;

export type HousekeepingStatusValue = (typeof HOUSEKEEPING_STATUS_VALUES)[number];

/**
 * 客室ステータスを動かしうる出来事。
 *
 * `TaskAction` に 1 つ足してある。
 *   - `generate` … タスク生成時（§11.1 の 1 行目）。操作ではないが表にある
 *
 * P2-04 が 2 つ足した（PK-SPEC-P2 §4.4 / §4.5）。
 *   - `inspectionPass` … 検査合格 → `READY`
 *   - `inspectionFail` … 検査不合格 → `DIRTY`（再清掃へ戻る）
 *
 * P2-16 が 1 つ足し、1 つ消した（同 §13）。
 *   - `emergencyOverride` … 検査待ちの残存タスクを検査せずに閉じる（§13.3）
 *
 * ── `bulkApprove` を消した（P2-16 / PK-SPEC-P2 §13.1）─────
 * P1 §11.1 の表 6 行目「一括承認 → READY」に対応する値を置いていたが、
 * **P2 リリースで一括承認そのものを廃止した。** P1 に到達経路は無く
 * （API も画面も作らなかった）、「P2 の検査フローが使う」という当時の
 * 見込みも外れた。**戻さないこと。** 「まとめて検査済にする」は、
 * 検査していない客室を検査済として集計させる入口になる（§2.3）。
 *
 * `emergencyOverride` は同じ「検査せずに `READY`」だが、置き換えではない。
 * **1 件ずつ・理由必須・監査ログ**で、§13.3 の残存タスクにしか使わない。
 * まとめて閉じられないことがこの値の要点なので、複数件版を作らないこと。
 */
export type RoomStatusTrigger =
  | TaskAction
  | "generate"
  | "inspectionPass"
  | "inspectionFail"
  | "emergencyOverride";

/**
 * その出来事のあとの客室ステータス（§11.1）。
 *
 * ```
 * タスク生成時          DIRTY
 * start                 IN_PROGRESS
 * pause                 変えない
 * complete かつ検査不要 READY
 * complete かつ検査必要 INSPECTING
 * block                 BLOCKED
 * cancel                変更しない
 * ```
 *
 * 表 6 行目の「一括承認 READY」は P2-16 で消えた（§13.1）。
 *
 * ── 表に無い操作 ────────────────────────────────────────
 * `assign` / `resume` は `null`（変えない）。割当は客室の状態ではないし、
 * 中断からの再開は既に `IN_PROGRESS` に居る。
 *
 * **`unblock` だけは表に無いのに `null` にしていない。** `block` で
 * `BLOCKED` にした客室を `null`（変えない）で戻すと、入室できるように
 * なったあとも客室ボードが「入室不可」を出し続ける。表の 1 行目
 * （生成時 = まだ清掃していない = `DIRTY`）と同じ意味へ戻す。
 * 仕様に行が無い判断なので docs/OPEN_QUESTIONS.md #038 に起票してある。
 *
 * @param trigger 起きたこと。
 * @param inspectionRequired 施設が検査を要求するか（`property.inspectionRequired`）。
 * @returns 新しい客室ステータス。**`null` は「変えない」。**
 */
export function housekeepingStatusFor(
  trigger: RoomStatusTrigger,
  inspectionRequired: boolean,
): HousekeepingStatusValue | null {
  switch (trigger) {
    case "generate":
      return "DIRTY";
    case "start":
      return "IN_PROGRESS";
    case "complete":
      return inspectionRequired ? "INSPECTING" : "READY";
    // PK-SPEC-P2 §4.4 / §4.5。**合格して初めて `READY`。**
    // 不合格は `DIRTY` へ戻す（再清掃の対象として客室ボードに出る）。
    case "inspectionPass":
      return "READY";
    // §13.3 の残存タスク。検査していないので「合格」ではないが、
    // 客室は使える状態にある（清掃は終わっている）。`INSPECTING` のまま
    // 残すと、二度と検査されない客室が客室ボードで作業中に見え続ける。
    case "emergencyOverride":
      return "READY";
    case "inspectionFail":
      return "DIRTY";
    case "block":
      return "BLOCKED";
    case "unblock":
      return "DIRTY";
    case "assign":
    case "pause":
    case "resume":
    case "cancel":
      return null;
  }
}

/**
 * 客室ボードの 4 区分（§9.5 の凡例「✓清掃済 ⟳作業中 ─未清掃 ⊘入室不可」）。
 *
 * `INSPECTING` は検査待ちで、**清掃員の作業としては終わっている。**
 * 凡例に 5 つ目を足さず「作業中」に寄せる（`taskGroupOf()` が
 * `AWAITING_INSPECTION` を「完了」に入れるのとは逆向きだが、こちらは
 * 客室が使える状態かを表す。検査が終わるまで客室は引き渡せない）。
 */
export const ROOM_BOARD_GROUPS = ["READY", "IN_PROGRESS", "DIRTY", "BLOCKED"] as const;

export type RoomBoardGroup = (typeof ROOM_BOARD_GROUPS)[number];

/** 客室ステータス → 客室ボードの区分。 */
export function roomBoardGroupOf(status: HousekeepingStatusValue): RoomBoardGroup {
  switch (status) {
    case "READY":
      return "READY";
    case "IN_PROGRESS":
    case "INSPECTING":
      return "IN_PROGRESS";
    case "DIRTY":
      return "DIRTY";
    case "BLOCKED":
      return "BLOCKED";
  }
}

/** 区分ごとの件数。**0 の区分も返す**（欠けると桁が動く）。 */
export function countRoomsByGroup(
  rooms: readonly { housekeepingStatus: HousekeepingStatusValue }[],
): Record<RoomBoardGroup, number> {
  const counts: Record<RoomBoardGroup, number> = {
    READY: 0,
    IN_PROGRESS: 0,
    DIRTY: 0,
    BLOCKED: 0,
  };
  for (const room of rooms) counts[roomBoardGroupOf(room.housekeepingStatus)] += 1;
  return counts;
}
