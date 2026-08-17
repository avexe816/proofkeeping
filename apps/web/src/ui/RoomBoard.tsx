/**
 * 客室ボードの盤面（PK-SPEC-P1 §9.5）。**W-03 と M-10 が共有する。**
 *
 * task: docs/tasks/P1-15.md
 * 参照: ui-prototypes/owner/pkown-v3-A-login-daily.html（03 客室ボード）
 *
 * ── 区分は 5 つ（プロトタイプの凡例）─────────────────────
 *   完了     緑（--ok）
 *   作業中   金（--accent）
 *   未着手   グレー
 *   保留     **青**（--info）
 *   再清掃   赤（--danger）
 * **保留（入室不可）を赤にしない**（PK-IMPL-CONTRACT §11.2「保留（入室不可）を
 * 赤で表示 → 青。清掃の遅れではない」）。この行を変えないこと。
 * 再清掃の赤は「急かし」ではなく区分の色（経過時間の赤とは別 / INV-05）。
 *
 * ── 差異のドットは渡された画面だけ ──────────────────────
 * `findingRoomIds` は差異を読める画面（W-03）だけが渡す。M-10 は渡さない —
 * `CLEANER` は差異へ到達できない（security.md §1）ので、ドットの有無からも
 * 差異の存在を読ませない。**このプロパティを渡す側は `finding.read` を
 * 確かめてから渡すこと。**
 *
 * ── タップで出すのは 3 つ ───────────────────────────────
 * §9.5「担当者・経過時間・写真枚数」。**操作履歴を出さない**（INV-07）。
 * 誰がいつ何を押したかではなく、いまどうなっているかだけを出す。
 */

import type { BoardCell, BoardDisplayGroup, BoardSection } from "@pk/engine";
import { BOARD_DISPLAY_GROUPS, boardDisplayGroupOf } from "@pk/engine";
import { useState } from "react";

import type { Translator, MessageKey } from "../lib/i18n.js";

/** 区分ごとの記号（プロトタイプの KPI 行）。**文言ではないので i18n を通さない。** */
export const BOARD_MARKS: Record<BoardDisplayGroup, string> = {
  READY: "✓",
  IN_PROGRESS: "▶",
  DIRTY: "○",
  BLOCKED: "⏸",
  REWORK: "↻",
};

export interface RoomBoardProps {
  sections: readonly BoardSection[];
  /** 担当者の表示名。**伏せるロールでは `null`**（INV-06）。 */
  staff: readonly { membershipId: string; staffNumber: string; displayName: string | null }[];
  t: Translator;
  /**
   * 稼働の差異（未確認）のある客室。**差異を読めない画面では渡さない**
   * （冒頭の注記）。渡されたときだけタイルのドットと凡例の項目が出る。
   */
  findingRoomIds?: ReadonlySet<string> | undefined;
  /** 選んだ客室の追加操作（手動上書きのフォーム等）。無ければ表示のみ。 */
  renderDetailExtra?: ((cell: BoardCell) => React.ReactNode) | undefined;
}

export function RoomBoard({
  sections,
  staff,
  t,
  findingRoomIds,
  renderDetailExtra,
}: RoomBoardProps): React.ReactElement {
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const staffById = new Map(staff.map((person) => [person.membershipId, person]));

  return (
    <div className="pk-board">
      {/* 凡例はプロトタイプどおり盤面の先頭（色 → 意味の対応を先に見せる）。 */}
      <p className="pk-board__legend">
        {BOARD_DISPLAY_GROUPS.map((group) => (
          <span key={group} className="pk-board__legendItem">
            <i className={`pk-board__swatch pk-board__swatch--${group}`} aria-hidden="true" />
            {t(`board.status.${group}` as MessageKey)}
          </span>
        ))}
        {findingRoomIds === undefined ? null : (
          <span className="pk-board__legendItem">
            <i className="pk-board__swatch pk-board__swatch--finding" aria-hidden="true" />
            {t("board.legend.finding")}
          </span>
        )}
      </p>

      {sections.map((section) => (
        <section key={section.floorName ?? (section.isNonSellable ? "_ns" : "_none")} className="pk-board__floor">
          <h2 className="pk-board__floorName">
            {section.isNonSellable
              ? t("board.nonSellable")
              : (section.floorName ?? t("board.noFloor"))}
          </h2>
          <div className="pk-board__grid">
            {section.rooms.map((cell) => {
              const group = boardDisplayGroupOf(cell);
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
                    {findingRoomIds?.has(cell.roomId) === true ? (
                      <span className="pk-room__dot" title={t("board.legend.finding")} />
                    ) : null}
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
