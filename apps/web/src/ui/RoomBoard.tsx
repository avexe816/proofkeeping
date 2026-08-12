/**
 * 客室ボードの盤面（PK-SPEC-P1 §9.5）。**W-03 と M-10 が共有する。**
 *
 * task: docs/tasks/P1-15.md
 * 参照: 仕様 §9.5 の凡例「✓清掃済 ⟳作業中 ─未清掃 ⊘入室不可」
 *
 * ── 色は 4 つだけ ───────────────────────────────────────
 *   清掃済   緑（--ok）
 *   作業中   金（--accent）
 *   未清掃   グレー
 *   入室不可 **青**（--info）
 * **入室不可を赤にしない**（PK-IMPL-CONTRACT §11.2「保留（入室不可）を
 * 赤で表示 → 青。清掃の遅れではない」）。この行を変えないこと。
 *
 * ── タップで出すのは 3 つ ───────────────────────────────
 * §9.5「担当者・経過時間・写真枚数」。**操作履歴を出さない**（INV-07）。
 * 誰がいつ何を押したかではなく、いまどうなっているかだけを出す。
 */

import type { BoardCell, BoardSection, RoomBoardGroup } from "@pk/engine";
import { roomBoardGroupOf } from "@pk/engine";
import { useState } from "react";

import type { Translator, MessageKey } from "../lib/i18n.js";

/** 区分ごとの記号（§9.5 の凡例）。**文言ではないので i18n を通さない。** */
export const BOARD_MARKS: Record<RoomBoardGroup, string> = {
  READY: "✓",
  IN_PROGRESS: "⟳",
  DIRTY: "─",
  BLOCKED: "⊘",
};

export interface RoomBoardProps {
  sections: readonly BoardSection[];
  /** 担当者の表示名。**伏せるロールでは `null`**（INV-06）。 */
  staff: readonly { membershipId: string; staffNumber: string; displayName: string | null }[];
  t: Translator;
  /** 選んだ客室の追加操作（手動上書きのフォーム等）。無ければ表示のみ。 */
  renderDetailExtra?: ((cell: BoardCell) => React.ReactNode) | undefined;
}

export function RoomBoard({
  sections,
  staff,
  t,
  renderDetailExtra,
}: RoomBoardProps): React.ReactElement {
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const staffById = new Map(staff.map((person) => [person.membershipId, person]));

  return (
    <div className="pk-board">
      {sections.map((section) => (
        <section key={section.floorName ?? (section.isNonSellable ? "_ns" : "_none")} className="pk-board__floor">
          <h2 className="pk-board__floorName">
            {section.isNonSellable
              ? t("board.nonSellable")
              : (section.floorName ?? t("board.noFloor"))}
          </h2>
          <div className="pk-board__grid">
            {section.rooms.map((cell) => {
              const group = roomBoardGroupOf(cell.housekeepingStatus);
              const isOpen = openRoomId === cell.roomId;
              return (
                <div key={cell.roomId} className="pk-board__slot">
                  <button
                    type="button"
                    className={`pk-room pk-room--${group}`}
                    aria-expanded={isOpen}
                    onClick={() => {
                      setOpenRoomId(isOpen ? null : cell.roomId);
                    }}
                  >
                    <span className="pk-room__number">{cell.roomNumber}</span>
                    <span className="pk-room__mark" aria-hidden="true">
                      {BOARD_MARKS[group]}
                    </span>
                    <span className="pk-room__status">
                      {t(`board.status.${group}` as MessageKey)}
                    </span>
                  </button>

                  {!isOpen ? null : (
                    <div className="pk-room__detail">
                      <dl>
                        <dt>{t("board.detail.assignee")}</dt>
                        <dd>{assigneeLabel(cell, staffById, t)}</dd>
                        <dt>{t("board.detail.elapsed")}</dt>
                        <dd>{elapsedLabel(cell, t)}</dd>
                        <dt>{t("board.detail.photos")}</dt>
                        <dd>{`${String(cell.photoCount)}${t("board.unit.photos")}`}</dd>
                      </dl>
                      {renderDetailExtra?.(cell)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <p className="pk-board__legend">
        {`✓ ${t("board.status.READY")} ⟳ ${t("board.status.IN_PROGRESS")} ` +
          `─ ${t("board.status.DIRTY")} ⊘ ${t("board.status.BLOCKED")}`}
      </p>
    </div>
  );
}

/** 担当者の表示。**伏せるロールでは「非表示」バッジ**（INV-06）。 */
function assigneeLabel(
  cell: BoardCell,
  staffById: Map<string, { staffNumber: string; displayName: string | null }>,
  t: Translator,
): string {
  if (cell.assigneeId === null) return t("board.detail.noAssignee");
  const person = staffById.get(cell.assigneeId);
  if (person === undefined) return t("board.detail.noAssignee");
  return person.displayName === null
    ? `${person.staffNumber}（${t("staff.nameHidden")}）`
    : `${person.displayName}（${person.staffNumber}）`;
}

/**
 * 経過時間の表示。
 *
 * 作業中は開始からの経過、完了済みは実作業時間。**超過を赤で出さない**
 * （INV-05）。ここは数字だけを置き、色は付けない。
 */
function elapsedLabel(cell: BoardCell, t: Translator): string {
  if (cell.elapsedMs !== null) {
    const minutes = Math.floor(cell.elapsedMs / 60_000);
    return `${String(minutes)}${t("board.unit.minutes")}`;
  }
  if (cell.workedMinutes !== null) {
    return `${String(cell.workedMinutes)}${t("board.unit.minutes")}`;
  }
  return t("board.detail.notStarted");
}
