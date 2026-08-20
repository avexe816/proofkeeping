/**
 * シフトと当日の割当の組み立て（P8-03）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例）/ security.md §5
 *
 * ── ここが守っているもの ────────────────────────────────
 *   1. 出勤済みは**タスクの開始**から数える（打刻の表が無い / #221）
 *   2. 引き算は予定の中で閉じる（予定外の稼働を欠勤側に混ぜない）
 *   3. 進捗 0% と「配っていない」を混ぜない
 *   4. 速度・順位・所要時間を持ち込まない
 */

import type { OrgStaff, ShiftRow } from "@pk/db";
import { describe, expect, it } from "vitest";

import { buildShiftBoard, weekOf, type BoardTask } from "./shiftBoard.js";

const ORG = "a1b2c3";
const DAY = "2026-08-20";
const WEEK = weekOf(DAY);

let seq = 0;

function person(overrides: Partial<OrgStaff> = {}): OrgStaff {
  seq += 1;
  return {
    membershipId: `${ORG}__mem_${String(seq).padStart(4, "0")}`,
    userId: `${ORG}__usr_${String(seq).padStart(4, "0")}`,
    role: "CLEANER",
    staffNumber: String(seq),
    displayName: `スタッフ${String(seq)}`,
    locale: "ja",
    isActive: true,
    ...overrides,
  };
}

function shift(membershipId: string, overrides: Partial<ShiftRow> = {}): ShiftRow {
  return {
    id: `${ORG}__shift_${membershipId.slice(-4)}`,
    membershipId,
    businessDate: DAY,
    shiftType: "WORK",
    propertyId: `${ORG}__prop_A`,
    startAt: null,
    endAt: null,
    breakMinutes: 60,
    note: null,
    ...overrides,
  };
}

function task(assigneeId: string | null, overrides: Partial<BoardTask> = {}): BoardTask {
  return { assigneeId, status: "ASSIGNED", startedAtMs: null, ...overrides };
}

function build(input: {
  staff: OrgStaff[];
  shifts?: ShiftRow[];
  tasks?: BoardTask[];
  weekShifts?: ShiftRow[];
}) {
  return buildShiftBoard({
    staff: input.staff,
    shifts: input.shifts ?? [],
    tasks: input.tasks ?? [],
    weekShifts: input.weekShifts ?? input.shifts ?? [],
    weekDates: WEEK,
    propertyNames: new Map([[`${ORG}__prop_A`, "サンプルホテル東京"]]),
  });
}

describe("buildShiftBoard — KPI", () => {
  it("出勤予定 = WORK の人数（休みを数えない）", () => {
    const a = person();
    const b = person();
    const board = build({
      staff: [a, b],
      shifts: [shift(a.membershipId), shift(b.membershipId, { shiftType: "OFF", propertyId: null })],
    });
    expect(board.summary.planned).toBe(1);
  });

  it("出勤済み = タスクを開始した人数（**打刻ではない**）", () => {
    const a = person();
    const b = person();
    const board = build({
      staff: [a, b],
      shifts: [shift(a.membershipId), shift(b.membershipId)],
      tasks: [task(a.membershipId, { startedAtMs: 1 })],
    });
    expect(board.summary.present).toBe(1);
    expect(board.summary.absent).toBe(1);
  });

  it("割当だけで開始していなければ出勤済みにしない", () => {
    const a = person();
    const board = build({
      staff: [a],
      shifts: [shift(a.membershipId)],
      tasks: [task(a.membershipId)],
    });
    expect(board.summary.present).toBe(0);
  });

  it("**予定に無い人が働いても欠勤側に混ぜない**（引き算は予定の中で閉じる）", () => {
    const planned = person();
    const walkIn = person();
    const board = build({
      staff: [planned, walkIn],
      shifts: [shift(planned.membershipId)],
      tasks: [
        task(planned.membershipId, { startedAtMs: 1 }),
        task(walkIn.membershipId, { startedAtMs: 1 }),
      ],
    });
    expect(board.summary).toEqual({ planned: 1, present: 1, absent: 0, unassignedTasks: 0 });
  });

  it("未割当 = 担当者の付いていないタスクの数（CANCELLED を数えない）", () => {
    const board = build({
      staff: [person()],
      tasks: [task(null), task(null, { status: "CANCELLED" })],
    });
    expect(board.summary.unassignedTasks).toBe(1);
  });
});

describe("buildShiftBoard — 当日の割当の行", () => {
  it("割当・完了・進捗が出る", () => {
    const a = person();
    const board = build({
      staff: [a],
      shifts: [shift(a.membershipId)],
      tasks: [
        task(a.membershipId, { status: "COMPLETED", startedAtMs: 1 }),
        task(a.membershipId, { status: "IN_PROGRESS", startedAtMs: 1 }),
      ],
    });
    expect(board.rows[0]).toMatchObject({
      assigned: 2,
      completed: 1,
      percent: 50,
      status: "WORKING",
      propertyName: "サンプルホテル東京",
    });
  });

  it("全部完了なら DONE", () => {
    const a = person();
    const board = build({
      staff: [a],
      shifts: [shift(a.membershipId)],
      tasks: [task(a.membershipId, { status: "COMPLETED", startedAtMs: 1 })],
    });
    expect(board.rows[0]?.status).toBe("DONE");
  });

  it("**割当 0 の進捗は `null`**（0% と「配っていない」を混ぜない）", () => {
    const a = person();
    const board = build({ staff: [a], shifts: [shift(a.membershipId)] });
    expect(board.rows[0]?.percent).toBeNull();
    expect(board.rows[0]?.status).toBe("NOT_STARTED");
  });

  it("休みの人は行に出ない（出るのは出勤予定だけ）", () => {
    const a = person();
    const board = build({
      staff: [a],
      shifts: [shift(a.membershipId, { shiftType: "OFF", propertyId: null })],
    });
    expect(board.rows).toHaveLength(0);
  });

  it("**速度・順位・所要時間の項目が無い**（security.md §5）", () => {
    const a = person();
    const board = build({
      staff: [a],
      shifts: [shift(a.membershipId)],
      tasks: [task(a.membershipId, { startedAtMs: 1 })],
    });
    const keys = Object.keys(board.rows[0] ?? {});
    for (const forbidden of ["minutes", "speed", "rank", "score", "duration"]) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden)), forbidden).toBe(false);
    }
  });
});

describe("buildShiftBoard — 週の棒グラフ", () => {
  it("日ごとの WORK の人数が 7 本並ぶ", () => {
    const a = person();
    const b = person();
    const monday = WEEK[0] ?? DAY;
    const board = build({
      staff: [a, b],
      shifts: [],
      weekShifts: [
        shift(a.membershipId, { businessDate: monday }),
        shift(b.membershipId, { businessDate: monday }),
        shift(a.membershipId, { businessDate: DAY }),
      ],
    });
    expect(board.week).toHaveLength(7);
    expect(board.week[0]).toEqual({ businessDate: monday, count: 2 });
    expect(board.week.find((bar) => bar.businessDate === DAY)?.count).toBe(1);
  });

  it("週平均は 7 日で割る（登録の無い日も分母に入る）", () => {
    const a = person();
    const board = build({
      staff: [a],
      shifts: [],
      weekShifts: WEEK.map((businessDate) => shift(a.membershipId, { businessDate })),
    });
    expect(board.weekAverage).toBe(1);
  });
});

describe("weekOf", () => {
  it("木曜を渡すと月曜はじまりの 7 日", () => {
    // 2026-08-20 は木曜。
    expect(weekOf("2026-08-20")).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
  });

  it("日曜はその週の最終日（翌週へ送らない）", () => {
    expect(weekOf("2026-08-23")[0]).toBe("2026-08-17");
  });

  it("月曜はその日から始まる", () => {
    expect(weekOf("2026-08-17")[0]).toBe("2026-08-17");
  });

  it("形が違えばその日 1 日だけ（例外にしない）", () => {
    expect(weekOf("bad")).toEqual(["bad"]);
  });
});
