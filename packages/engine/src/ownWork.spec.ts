/**
 * M-11 自分の実績（P1-17 / PK-SPEC-P1 §9.6）。
 *
 * ルール: .claude/rules/security.md §5 / testing.md §3
 */

import { describe, expect, it } from "vitest";

import {
  MINIMUM_TASKS_FOR_AVERAGE,
  summarizeOwnWork,
  weekRangeOf,
  type OwnWorkTask,
} from "./ownWork.js";

function completed(count: number, minutes: number): OwnWorkTask[] {
  return Array.from({ length: count }, () => ({
    status: "COMPLETED" as const,
    actualMinutes: minutes,
  }));
}

describe("summarizeOwnWork — 事実（正例）", () => {
  it("完了件数を数える", () => {
    expect(summarizeOwnWork(completed(3, 20)).completed).toBe(3);
  });

  it("検査待ちも完了に入れる（自分の作業としては終わり）", () => {
    expect(
      summarizeOwnWork([{ status: "AWAITING_INSPECTION", actualMinutes: 25 }]).completed,
    ).toBe(1);
  });

  it("中断中も作業中に数える", () => {
    expect(
      summarizeOwnWork([
        { status: "IN_PROGRESS", actualMinutes: null },
        { status: "PAUSED", actualMinutes: null },
      ]).inProgress,
    ).toBe(2);
  });

  it("合計作業時間は完了ぶんの実作業時間", () => {
    expect(summarizeOwnWork(completed(4, 30)).workedMinutes).toBe(120);
  });

  it("未完了のタスクは合計に入れない", () => {
    expect(
      summarizeOwnWork([
        { status: "COMPLETED", actualMinutes: 30 },
        { status: "IN_PROGRESS", actualMinutes: 90 },
      ]).workedMinutes,
    ).toBe(30);
  });

  it("空でも落ちない", () => {
    expect(summarizeOwnWork([])).toEqual({
      completed: 0,
      inProgress: 0,
      workedMinutes: 0,
      averageMinutes: null,
    });
  });
});

describe("summarizeOwnWork — 平均の閾値（負例）", () => {
  it("20 件未満なら平均を出さない（security.md §5）", () => {
    expect(summarizeOwnWork(completed(MINIMUM_TASKS_FOR_AVERAGE - 1, 26)).averageMinutes).toBeNull();
  });

  it("20 件ちょうどで平均を出す", () => {
    expect(summarizeOwnWork(completed(MINIMUM_TASKS_FOR_AVERAGE, 26)).averageMinutes).toBe(26);
  });

  it("平均を伏せても件数と時間は出す", () => {
    const summary = summarizeOwnWork(completed(5, 30));
    expect(summary.completed).toBe(5);
    expect(summary.workedMinutes).toBe(150);
    expect(summary.averageMinutes).toBeNull();
  });

  it("実作業時間の無い完了は平均の母数に入れない", () => {
    const tasks: OwnWorkTask[] = [
      ...completed(MINIMUM_TASKS_FOR_AVERAGE, 30),
      { status: "COMPLETED", actualMinutes: null },
    ];
    expect(summarizeOwnWork(tasks).averageMinutes).toBe(30);
  });

  it("作業中だけでは平均が出ない", () => {
    const tasks: OwnWorkTask[] = Array.from({ length: 30 }, () => ({
      status: "IN_PROGRESS" as const,
      actualMinutes: null,
    }));
    expect(summarizeOwnWork(tasks).averageMinutes).toBeNull();
  });

  it("取消したタスクを完了に数えない", () => {
    expect(summarizeOwnWork([{ status: "CANCELLED", actualMinutes: 30 }]).completed).toBe(0);
  });
});

describe("weekRangeOf — 月曜はじまり", () => {
  it("週の途中（木曜）", () => {
    // 2026-08-13 は木曜。
    expect(weekRangeOf("2026-08-13")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
  });

  it("月曜そのもの", () => {
    expect(weekRangeOf("2026-08-10")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
  });

  it("日曜は前の月曜から", () => {
    expect(weekRangeOf("2026-08-16")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
  });

  it("月をまたぐ週", () => {
    // 2026-09-01 は火曜。月曜は 8/31。
    expect(weekRangeOf("2026-09-01")).toEqual({ from: "2026-08-31", to: "2026-09-06" });
  });

  it("年をまたぐ週", () => {
    // 2027-01-01 は金曜。月曜は 2026-12-28。
    expect(weekRangeOf("2027-01-01")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
});
