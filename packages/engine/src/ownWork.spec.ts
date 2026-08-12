/**
 * M-11 自分の実績（P1-17 / PK-SPEC-P1 §9.6）。
 *
 * ルール: .claude/rules/security.md §5 / testing.md §3
 */

import { describe, expect, it } from "vitest";

import {
  MINIMUM_TASKS_FOR_AVERAGE,
  monthRangeOf,
  summarizeOwnWork,
  summarizeOwnWorkByProperty,
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

describe("monthRangeOf — 今月（§19.9）", () => {
  it("月の途中", () => {
    expect(monthRangeOf("2026-08-12")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("月初", () => {
    expect(monthRangeOf("2026-08-01")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("月末", () => {
    expect(monthRangeOf("2026-08-31")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("30 日までの月", () => {
    expect(monthRangeOf("2026-09-15")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("2 月（平年）", () => {
    expect(monthRangeOf("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("2 月（閏年）", () => {
    expect(monthRangeOf("2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("年末", () => {
    expect(monthRangeOf("2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("summarizeOwnWorkByProperty — 施設別（§19.9 / 正例）", () => {
  it("施設ごとに完了件数を数える", () => {
    expect(
      summarizeOwnWorkByProperty([
        { propertyId: "p_a", status: "COMPLETED" },
        { propertyId: "p_a", status: "COMPLETED" },
        { propertyId: "p_b", status: "COMPLETED" },
      ]),
    ).toEqual([
      { propertyId: "p_a", completed: 2 },
      { propertyId: "p_b", completed: 1 },
    ]);
  });

  it("検査待ちも完了に入れる（`summarizeOwnWork()` と同じ扱い）", () => {
    expect(
      summarizeOwnWorkByProperty([{ propertyId: "p_a", status: "AWAITING_INSPECTION" }]),
    ).toEqual([{ propertyId: "p_a", completed: 1 }]);
  });

  it("件数の多い順に並ぶ", () => {
    const rows = summarizeOwnWorkByProperty([
      { propertyId: "p_a", status: "COMPLETED" },
      { propertyId: "p_b", status: "COMPLETED" },
      { propertyId: "p_b", status: "COMPLETED" },
    ]);
    expect(rows.map((row) => row.propertyId)).toEqual(["p_b", "p_a"]);
  });

  it("同数なら施設 ID の昇順（並びが揺れない）", () => {
    const rows = summarizeOwnWorkByProperty([
      { propertyId: "p_b", status: "COMPLETED" },
      { propertyId: "p_a", status: "COMPLETED" },
    ]);
    expect(rows.map((row) => row.propertyId)).toEqual(["p_a", "p_b"]);
  });

  it("合計は各行の和と一致する", () => {
    const rows = summarizeOwnWorkByProperty([
      { propertyId: "p_a", status: "COMPLETED" },
      { propertyId: "p_a", status: "COMPLETED" },
      { propertyId: "p_b", status: "COMPLETED" },
    ]);
    expect(rows.reduce((sum, row) => sum + row.completed, 0)).toBe(3);
  });
});

describe("summarizeOwnWorkByProperty — 施設別（負例）", () => {
  it("完了が 1 件も無い施設は行を作らない", () => {
    expect(
      summarizeOwnWorkByProperty([
        { propertyId: "p_a", status: "ASSIGNED" },
        { propertyId: "p_a", status: "IN_PROGRESS" },
      ]),
    ).toEqual([]);
  });

  it("取消は数えない", () => {
    expect(summarizeOwnWorkByProperty([{ propertyId: "p_a", status: "CANCELLED" }])).toEqual([]);
  });

  it("再清掃（未完了）は数えない", () => {
    expect(summarizeOwnWorkByProperty([{ propertyId: "p_a", status: "REWORK" }])).toEqual([]);
  });

  it("入室不可は数えない", () => {
    expect(summarizeOwnWorkByProperty([{ propertyId: "p_a", status: "BLOCKED" }])).toEqual([]);
  });

  it("空の入力は空の結果", () => {
    expect(summarizeOwnWorkByProperty([])).toEqual([]);
  });

  it("入力を書き換えない", () => {
    const tasks = [{ propertyId: "p_a", status: "COMPLETED" as const }];
    const before = JSON.stringify(tasks);
    summarizeOwnWorkByProperty(tasks);
    expect(JSON.stringify(tasks)).toBe(before);
  });
});
