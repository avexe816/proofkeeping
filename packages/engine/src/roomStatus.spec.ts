/**
 * 客室ステータスの同期規則（P1-16 / PK-SPEC-P1 §11.1）。
 *
 * ルール: .claude/rules/testing.md §3
 *   「すべてのルール・計算に正例と負例を最低 5 件ずつ」
 */

import { describe, expect, it } from "vitest";

import {
  HOUSEKEEPING_STATUS_VALUES,
  ROOM_BOARD_GROUPS,
  countRoomsByGroup,
  housekeepingStatusFor,
  roomBoardGroupOf,
  type HousekeepingStatusValue,
} from "./roomStatus.js";

describe("housekeepingStatusFor — §11.1 の表", () => {
  it("タスク生成時は DIRTY", () => {
    expect(housekeepingStatusFor("generate", false)).toBe("DIRTY");
    expect(housekeepingStatusFor("generate", true)).toBe("DIRTY");
  });

  it("start で IN_PROGRESS", () => {
    expect(housekeepingStatusFor("start", false)).toBe("IN_PROGRESS");
  });

  it("complete かつ検査不要なら READY", () => {
    expect(housekeepingStatusFor("complete", false)).toBe("READY");
  });

  it("complete かつ検査必要なら INSPECTING（READY にしない）", () => {
    // §11.1 MUST。**検査が終わるまで READY にしない。**
    expect(housekeepingStatusFor("complete", true)).toBe("INSPECTING");
  });

  it("一括承認で READY", () => {
    expect(housekeepingStatusFor("bulkApprove", true)).toBe("READY");
  });

  it("block で BLOCKED", () => {
    expect(housekeepingStatusFor("block", false)).toBe("BLOCKED");
  });
});

describe("housekeepingStatusFor — 変えない操作（負例）", () => {
  it("pause は変えない", () => {
    expect(housekeepingStatusFor("pause", false)).toBeNull();
  });

  it("resume は変えない（既に IN_PROGRESS）", () => {
    expect(housekeepingStatusFor("resume", false)).toBeNull();
  });

  it("cancel は変えない", () => {
    expect(housekeepingStatusFor("cancel", false)).toBeNull();
  });

  it("assign は変えない（割当は客室の状態ではない）", () => {
    expect(housekeepingStatusFor("assign", false)).toBeNull();
  });

  it("検査の要否は complete 以外に効かない", () => {
    for (const trigger of ["start", "block", "pause", "cancel", "assign"] as const) {
      expect(housekeepingStatusFor(trigger, true), trigger).toBe(
        housekeepingStatusFor(trigger, false),
      );
    }
  });

  it("unblock は BLOCKED のまま残さない（OPEN_QUESTIONS #038）", () => {
    // 入室できるようになった客室が「入室不可」を出し続けない。
    expect(housekeepingStatusFor("unblock", false)).toBe("DIRTY");
  });
});

describe("roomBoardGroupOf", () => {
  it("INSPECTING は作業中に寄せる（凡例は 4 つ / §9.5）", () => {
    expect(roomBoardGroupOf("INSPECTING")).toBe("IN_PROGRESS");
  });

  it("全ステータスが 4 区分のいずれかへ落ちる", () => {
    for (const status of HOUSEKEEPING_STATUS_VALUES) {
      expect(ROOM_BOARD_GROUPS, status).toContain(roomBoardGroupOf(status));
    }
  });
});

describe("countRoomsByGroup", () => {
  const rooms = (statuses: readonly HousekeepingStatusValue[]) =>
    statuses.map((housekeepingStatus) => ({ housekeepingStatus }));

  it("0 の区分も返す（欠けると桁が動く）", () => {
    expect(countRoomsByGroup(rooms(["READY"]))).toEqual({
      READY: 1,
      IN_PROGRESS: 0,
      DIRTY: 0,
      BLOCKED: 0,
    });
  });

  it("検査待ちを作業中として数える", () => {
    expect(countRoomsByGroup(rooms(["INSPECTING", "IN_PROGRESS"])).IN_PROGRESS).toBe(2);
  });

  it("空でも 4 区分すべてを返す", () => {
    expect(Object.keys(countRoomsByGroup([]))).toHaveLength(ROOM_BOARD_GROUPS.length);
  });
});
