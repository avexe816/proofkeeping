/**
 * 作業時間の集計。**中断を 3 回挟んでも正しいこと**が P1-05 の完了条件。
 *
 * 仕様: docs/PK-SPEC-P1.md §2.2 / §14.1
 */

import { describe, expect, it } from "vitest";

import { actualMinutesOf, summarizeTimeLogs, type TimeLogEntry } from "./taskTime.js";

const BASE = Date.parse("2026-08-12T01:00:00.000Z");

/** `分` を epoch ミリ秒へ。 */
function at(minutes: number): number {
  return BASE + minutes * 60_000;
}

function log(event: string, minutes: number): TimeLogEntry {
  return { event, occurredAt: at(minutes) };
}

describe("summarizeTimeLogs — 正例", () => {
  it("開始 → 完了 の 40 分", () => {
    expect(actualMinutesOf([log("START", 0), log("COMPLETE", 40)])).toBe(40);
  });

  it("中断を 1 回挟むと中断時間を含まない", () => {
    const entries = [log("START", 0), log("PAUSE", 10), log("RESUME", 25), log("COMPLETE", 40)];

    expect(actualMinutesOf(entries)).toBe(25);
  });

  it("中断を 3 回挟んでも正しい（受け入れ基準 §14.1）", () => {
    const entries = [
      log("START", 0),
      log("PAUSE", 10), // 10 分
      log("RESUME", 20),
      log("PAUSE", 25), // 5 分
      log("RESUME", 40),
      log("PAUSE", 55), // 15 分
      log("RESUME", 70),
      log("COMPLETE", 80), // 10 分
    ];

    const summary = summarizeTimeLogs(entries);

    expect(summary.workedMs).toBe(40 * 60_000);
    expect(summary.pauseCount).toBe(3);
    expect(summary.isOpen).toBe(false);
  });

  it("入室不可を挟んだ区間は作業時間に含まない", () => {
    const entries = [log("START", 0), log("BLOCK", 5), log("UNBLOCK", 30), log("COMPLETE", 40)];

    expect(actualMinutesOf(entries)).toBe(15);
  });

  it("作業中（未完了）でも、それまでの区間を数える", () => {
    const summary = summarizeTimeLogs([log("START", 0), log("PAUSE", 12), log("RESUME", 20)]);

    expect(summary.workedMs).toBe(12 * 60_000);
    expect(summary.isOpen).toBe(true);
    expect(summary.completedAt).toBeNull();
  });

  it("開始時刻は最初の START、完了時刻は最後の COMPLETE", () => {
    const summary = summarizeTimeLogs([
      log("START", 0),
      log("PAUSE", 5),
      log("RESUME", 10),
      log("COMPLETE", 20),
    ]);

    expect(summary.startedAt).toBe(at(0));
    expect(summary.completedAt).toBe(at(20));
  });

  it("順序がばらばらに届いても時刻順に並べ直す（オフライン再送）", () => {
    const inOrder = [log("START", 0), log("PAUSE", 10), log("RESUME", 20), log("COMPLETE", 30)];
    const shuffled = [inOrder[3], inOrder[1], inOrder[0], inOrder[2]] as TimeLogEntry[];

    expect(actualMinutesOf(shuffled)).toBe(actualMinutesOf(inOrder));
  });
});

describe("summarizeTimeLogs — 壊れた並びを落とさない", () => {
  it("空のログは 0 分", () => {
    expect(actualMinutesOf([])).toBe(0);
  });

  it("二重の START で区間が入れ子にならない", () => {
    const entries = [log("START", 0), log("START", 5), log("COMPLETE", 20)];

    expect(actualMinutesOf(entries)).toBe(20);
  });

  it("開いていない区間を閉じるイベントは無視する", () => {
    expect(actualMinutesOf([log("PAUSE", 10), log("COMPLETE", 20)])).toBe(0);
  });

  it("RESUME から始まる並びでも例外にしない", () => {
    expect(actualMinutesOf([log("RESUME", 0), log("COMPLETE", 15)])).toBe(15);
  });

  it("時刻が巻き戻っていても負の値を足さない", () => {
    // 同一ミリ秒では閉じる側を先に見るため、この並びは 0 分になる。
    expect(actualMinutesOf([log("START", 30), log("COMPLETE", 30)])).toBe(0);
  });

  it("同じ完了を 3 回送っても作業時間が変わらない（§14.2）", () => {
    const once = [log("START", 0), log("COMPLETE", 30)];
    const thrice = [log("START", 0), log("COMPLETE", 30), log("COMPLETE", 30), log("COMPLETE", 30)];

    expect(actualMinutesOf(thrice)).toBe(actualMinutesOf(once));
  });

  it("秒未満は切り捨てる（実測より多く数えない）", () => {
    const entries: TimeLogEntry[] = [
      { event: "START", occurredAt: BASE },
      { event: "COMPLETE", occurredAt: BASE + 119_000 },
    ];

    expect(actualMinutesOf(entries)).toBe(1);
  });
});
