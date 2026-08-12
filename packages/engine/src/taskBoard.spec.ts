/**
 * 並び順と経過時間の色（PK-SPEC-P1 §9.2・§9.3 / INV-05）。
 *
 * task: docs/tasks/P1-08.md / docs/tasks/P1-09.md
 *
 * `packages/engine` は正例・負例を最低 5 件ずつ持つ（testing.md §3）。
 */

import { describe, expect, it } from "vitest";

import {
  ELAPSED_TONES,
  countByGroup,
  elapsedToneOf,
  remainingMinutes,
  sortTasksForBoard,
  taskGroupOf,
  type SortableTask,
} from "./taskBoard.js";
import type { TaskStatusValue } from "./taskStatus.js";

function task(status: TaskStatusValue, roomNumber: string, priority = 50): SortableTask {
  return { status, roomNumber, priority };
}

describe("taskGroupOf", () => {
  it("未着手は CREATED と ASSIGNED の 2 つ", () => {
    expect(taskGroupOf("CREATED")).toBe("TODO");
    expect(taskGroupOf("ASSIGNED")).toBe("TODO");
  });

  it("作業中は IN_PROGRESS と PAUSED をまとめる", () => {
    expect(taskGroupOf("IN_PROGRESS")).toBe("IN_PROGRESS");
    expect(taskGroupOf("PAUSED")).toBe("IN_PROGRESS");
  });

  it("検査待ちは清掃員から見て完了", () => {
    expect(taskGroupOf("AWAITING_INSPECTION")).toBe("DONE");
    expect(taskGroupOf("COMPLETED")).toBe("DONE");
  });

  it("差戻しと入室不可はそれぞれ独立した段", () => {
    expect(taskGroupOf("REWORK")).toBe("REWORK");
    expect(taskGroupOf("BLOCKED")).toBe("BLOCKED");
  });

  it("取消はどの段にも入らない", () => {
    expect(taskGroupOf("CANCELLED")).toBeNull();
  });
});

describe("sortTasksForBoard", () => {
  it("作業中 → 差戻し → 未着手 → 入室不可 → 完了 の順に並ぶ（§9.2）", () => {
    const sorted = sortTasksForBoard([
      task("COMPLETED", "301"),
      task("BLOCKED", "302"),
      task("ASSIGNED", "303"),
      task("REWORK", "304"),
      task("IN_PROGRESS", "305"),
    ]);
    expect(sorted.map((row) => row.roomNumber)).toEqual(["305", "304", "303", "302", "301"]);
  });

  it("同じ段では priority の昇順", () => {
    const sorted = sortTasksForBoard([
      task("ASSIGNED", "301", 70),
      task("ASSIGNED", "302", 10),
      task("ASSIGNED", "303", 40),
    ]);
    expect(sorted.map((row) => row.roomNumber)).toEqual(["302", "303", "301"]);
  });

  it("priority が同じなら客室番号を数値として比べる", () => {
    const sorted = sortTasksForBoard([task("ASSIGNED", "1002"), task("ASSIGNED", "302")]);
    expect(sorted.map((row) => row.roomNumber)).toEqual(["302", "1002"]);
  });

  it("数字で始まらない客室番号は後ろへ回る", () => {
    const sorted = sortTasksForBoard([task("ASSIGNED", "LOBBY"), task("ASSIGNED", "305")]);
    expect(sorted.map((row) => row.roomNumber)).toEqual(["305", "LOBBY"]);
  });

  it("取消は一覧から落ちる", () => {
    const sorted = sortTasksForBoard([task("CANCELLED", "301"), task("ASSIGNED", "302")]);
    expect(sorted.map((row) => row.roomNumber)).toEqual(["302"]);
  });

  it("入力の配列を書き換えない", () => {
    const input = [task("COMPLETED", "301"), task("IN_PROGRESS", "302")];
    sortTasksForBoard(input);
    expect(input.map((row) => row.roomNumber)).toEqual(["301", "302"]);
  });
});

describe("countByGroup", () => {
  it("5 段すべてを返す。0 の段も欠けない", () => {
    expect(countByGroup([{ status: "ASSIGNED" }])).toEqual({
      TODO: 1,
      IN_PROGRESS: 0,
      REWORK: 0,
      BLOCKED: 0,
      DONE: 0,
    });
  });

  it("取消は数えない", () => {
    const counts = countByGroup([
      { status: "CANCELLED" },
      { status: "CANCELLED" },
      { status: "COMPLETED" },
    ]);
    expect(counts.DONE).toBe(1);
  });
});

describe("elapsedToneOf", () => {
  const STANDARD = 40; // 分

  it("目安以内は NORMAL", () => {
    expect(elapsedToneOf(STANDARD, 0)).toBe("NORMAL");
    expect(elapsedToneOf(STANDARD, 20 * 60_000)).toBe("NORMAL");
  });

  it("ちょうど目安は NORMAL（超えていない）", () => {
    expect(elapsedToneOf(STANDARD, 40 * 60_000)).toBe("NORMAL");
  });

  it("超えたら OVER（オレンジ）", () => {
    expect(elapsedToneOf(STANDARD, 40 * 60_000 + 1)).toBe("OVER");
    expect(elapsedToneOf(STANDARD, 55 * 60_000)).toBe("OVER");
  });

  it("1.5 倍で FAR_OVER（グレー）", () => {
    expect(elapsedToneOf(STANDARD, 60 * 60_000)).toBe("FAR_OVER");
    expect(elapsedToneOf(STANDARD, 120 * 60_000)).toBe("FAR_OVER");
  });

  it("目安が無いタスクを超過と見せない", () => {
    expect(elapsedToneOf(0, 10 * 60_000)).toBe("NORMAL");
    expect(elapsedToneOf(-5, 10 * 60_000)).toBe("NORMAL");
  });

  it("返しうる値は 3 つだけ。赤に相当する値が語彙に無い（INV-05）", () => {
    // 型でも弾かれるが、**語彙そのもの**を固定しておく。
    // `ELAPSED_TONES` に赤を足す変更は、ここが落ちて気付ける。
    expect([...ELAPSED_TONES]).toEqual(["NORMAL", "OVER", "FAR_OVER"]);

    const tones = new Set(
      [0, 1, 39, 41, 60, 120, 600].map((minutes) => elapsedToneOf(STANDARD, minutes * 60_000)),
    );
    for (const tone of tones) expect(ELAPSED_TONES).toContain(tone);
  });
});

describe("remainingMinutes", () => {
  it("残りを切り上げて返す", () => {
    expect(remainingMinutes(40, 20 * 60_000)).toBe(20);
    expect(remainingMinutes(40, 20.5 * 60_000)).toBe(20);
  });

  it("超過していても負の値を返さない", () => {
    expect(remainingMinutes(40, 41 * 60_000)).toBe(0);
    expect(remainingMinutes(40, 400 * 60_000)).toBe(0);
  });
});
