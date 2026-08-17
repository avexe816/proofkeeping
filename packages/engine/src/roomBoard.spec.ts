/**
 * 客室ボードの組み立て（P1-15 / PK-SPEC-P1 §9.5）。
 *
 * ルール: .claude/rules/testing.md §3
 */

import { describe, expect, it } from "vitest";

import {
  boardDisplayGroupOf,
  buildRoomBoard,
  countBoardDisplayGroups,
  type BoardRoomInput,
  type BoardTaskInput,
} from "./roomBoard.js";

const NOW = Date.parse("2026-08-12T02:00:00.000Z");

function room(partial: Partial<BoardRoomInput> & { roomId: string }): BoardRoomInput {
  return {
    roomNumber: "301",
    floorName: "3F",
    floorOrder: 3,
    isSellable: true,
    housekeepingStatus: "DIRTY",
    ...partial,
  };
}

function boardTask(partial: Partial<BoardTaskInput> & { taskId: string; roomId: string }): BoardTaskInput {
  return {
    status: "CREATED",
    assigneeId: null,
    startedAt: null,
    actualMinutes: null,
    photoCount: 0,
    ...partial,
  };
}

describe("buildRoomBoard — 並び（正例）", () => {
  it("階の順に並べる", () => {
    const sections = buildRoomBoard(
      [
        room({ roomId: "r4", roomNumber: "401", floorName: "4F", floorOrder: 4 }),
        room({ roomId: "r3", roomNumber: "301", floorName: "3F", floorOrder: 3 }),
      ],
      [],
      NOW,
    );
    expect(sections.map((section) => section.floorName)).toEqual(["3F", "4F"]);
  });

  it("同じ階では客室番号順（数値として）", () => {
    const sections = buildRoomBoard(
      [
        room({ roomId: "r2", roomNumber: "1002" }),
        room({ roomId: "r1", roomNumber: "302" }),
      ],
      [],
      NOW,
    );
    expect(sections[0]?.rooms.map((cell) => cell.roomNumber)).toEqual(["302", "1002"]);
  });

  it("清掃専用の場所は別の区画になる", () => {
    const sections = buildRoomBoard(
      [
        room({ roomId: "r1" }),
        room({ roomId: "p1", roomNumber: "PANTRY", isSellable: false, floorName: null, floorOrder: null }),
      ],
      [],
      NOW,
    );
    expect(sections).toHaveLength(2);
    expect(sections[1]?.isNonSellable).toBe(true);
  });

  it("階が未登録の客室も落とさない", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1", floorName: null, floorOrder: null })],
      [],
      NOW,
    );
    expect(sections[0]?.rooms).toHaveLength(1);
  });

  it("タスクが 1 件も無くても盤面を返す", () => {
    const sections = buildRoomBoard([room({ roomId: "r1" })], [], NOW);
    expect(sections[0]?.rooms[0]?.taskId).toBeNull();
  });
});

describe("buildRoomBoard — セルの中身", () => {
  it("作業中は経過を出す", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1", housekeepingStatus: "IN_PROGRESS" })],
      [
        boardTask({
          taskId: "t1",
          roomId: "r1",
          status: "IN_PROGRESS",
          startedAt: NOW - 15 * 60_000,
          assigneeId: "m_a",
          photoCount: 3,
        }),
      ],
      NOW,
    );
    const cell = sections[0]?.rooms[0];
    expect(cell?.elapsedMs).toBe(15 * 60_000);
    expect(cell?.assigneeId).toBe("m_a");
    expect(cell?.photoCount).toBe(3);
  });

  it("完了済みは経過ではなく実作業時間を出す", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1", housekeepingStatus: "READY" })],
      [boardTask({ taskId: "t1", roomId: "r1", status: "COMPLETED", actualMinutes: 26 })],
      NOW,
    );
    expect(sections[0]?.rooms[0]?.elapsedMs).toBeNull();
    expect(sections[0]?.rooms[0]?.workedMinutes).toBe(26);
  });

  it("1 客室に複数タスクがあれば作業中を優先する", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1" })],
      [
        boardTask({ taskId: "done", roomId: "r1", status: "COMPLETED" }),
        boardTask({ taskId: "running", roomId: "r1", status: "IN_PROGRESS", startedAt: NOW }),
      ],
      NOW,
    );
    expect(sections[0]?.rooms[0]?.taskId).toBe("running");
  });
});

describe("buildRoomBoard — 出さないもの（負例）", () => {
  it("取消したタスクをセルに出さない", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1" })],
      [boardTask({ taskId: "t1", roomId: "r1", status: "CANCELLED" })],
      NOW,
    );
    expect(sections[0]?.rooms[0]?.taskId).toBeNull();
  });

  it("客室マスタに無いタスクを盤面に出さない", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1" })],
      [boardTask({ taskId: "t1", roomId: "gone" })],
      NOW,
    );
    expect(sections[0]?.rooms).toHaveLength(1);
    expect(sections[0]?.rooms[0]?.taskId).toBeNull();
  });

  it("未着手は経過も実作業時間も持たない", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1" })],
      [boardTask({ taskId: "t1", roomId: "r1", status: "ASSIGNED" })],
      NOW,
    );
    expect(sections[0]?.rooms[0]?.elapsedMs).toBeNull();
    expect(sections[0]?.rooms[0]?.workedMinutes).toBeNull();
  });

  it("客室が 1 件も無ければ区画も無い", () => {
    expect(buildRoomBoard([], [], NOW)).toEqual([]);
  });

  it("3 回組み立てても同じ盤面になる", () => {
    const rooms = [room({ roomId: "r1" }), room({ roomId: "r2", roomNumber: "302" })];
    const tasks = [boardTask({ taskId: "t1", roomId: "r1" })];
    const first = buildRoomBoard(rooms, tasks, NOW);
    expect(buildRoomBoard(rooms, tasks, NOW)).toEqual(first);
    expect(buildRoomBoard(rooms, tasks, NOW)).toEqual(first);
  });
});

describe("表示区分（プロトタイプ owner 03 の 5 区分）", () => {
  // 正例
  it("差戻しタスクの立った未着手は「再清掃」", () => {
    expect(
      boardDisplayGroupOf({ housekeepingStatus: "DIRTY", isRework: true }),
    ).toBe("REWORK");
  });

  it("差戻しの無い未着手はそのまま「未着手」", () => {
    expect(
      boardDisplayGroupOf({ housekeepingStatus: "DIRTY", isRework: false }),
    ).toBe("DIRTY");
  });

  it("buildRoomBoard は REWORK タスクのセルに isRework を立てる", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1" })],
      [boardTask({ taskId: "t1", roomId: "r1", status: "REWORK" })],
      0,
    );
    expect(sections[0]?.rooms[0]?.isRework).toBe(true);
  });

  it("countBoardDisplayGroups は 5 区分すべてを返す（0 も欠けない）", () => {
    const sections = buildRoomBoard(
      [
        room({ roomId: "r1", roomNumber: "301", housekeepingStatus: "READY" }),
        room({ roomId: "r2", roomNumber: "302", housekeepingStatus: "DIRTY" }),
        room({ roomId: "r3", roomNumber: "303", housekeepingStatus: "DIRTY" }),
      ],
      [boardTask({ taskId: "t1", roomId: "r3", status: "REWORK" })],
      0,
    );
    expect(countBoardDisplayGroups(sections)).toEqual({
      READY: 1,
      IN_PROGRESS: 0,
      DIRTY: 1,
      BLOCKED: 0,
      REWORK: 1,
    });
  });

  it("検査待ち（INSPECTING）は作業中に数える（§9.5 の寄せ方のまま）", () => {
    expect(
      boardDisplayGroupOf({ housekeepingStatus: "INSPECTING", isRework: false }),
    ).toBe("IN_PROGRESS");
  });

  // 負例
  it("再清掃を実施中（IN_PROGRESS）の客室は「作業中」で、再清掃に数えない", () => {
    expect(
      boardDisplayGroupOf({ housekeepingStatus: "IN_PROGRESS", isRework: true }),
    ).toBe("IN_PROGRESS");
  });

  it("清掃専用の場所は件数に入らない（§24.3）", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1", roomNumber: "PANTRY", isSellable: false })],
      [],
      0,
    );
    expect(countBoardDisplayGroups(sections)).toEqual({
      READY: 0,
      IN_PROGRESS: 0,
      DIRTY: 0,
      BLOCKED: 0,
      REWORK: 0,
    });
  });

  it("完了済みタスクしか無い客室は isRework にならない", () => {
    const sections = buildRoomBoard(
      [room({ roomId: "r1" })],
      [boardTask({ taskId: "t1", roomId: "r1", status: "COMPLETED" })],
      0,
    );
    expect(sections[0]?.rooms[0]?.isRework).toBe(false);
  });
});
