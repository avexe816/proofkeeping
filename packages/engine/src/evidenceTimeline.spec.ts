/**
 * `buildEvidenceTimeline()` のテスト（PK-SPEC-P2 §12.3）。
 *
 * task:  docs/tasks/P2-09.md
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ここでの「負例」は「タイムラインに**出てはいけない**行」。
 * 未完了の検査の判定・免除時刻の無い免除・存在しない再清掃の開始など、
 * **先回りして出すと事実と違う**ものを押さえる。
 */

import { describe, expect, it } from "vitest";

import {
  buildEvidenceTimeline,
  TIMELINE_KINDS,
  type EvidenceTimelineInput,
  type TimelineInspectionInput,
  type TimelineReworkInput,
  type TimelineTimeLogInput,
} from "./evidenceTimeline.js";

/** 2026-09-10 13:00:00 JST 相当。**値そのものに意味は無い。** */
const BASE = Date.UTC(2026, 8, 10, 4, 0, 0);

/** 分をミリ秒へ。読みやすさのためだけ。 */
function at(minutes: number): number {
  return BASE + minutes * 60_000;
}

function log(
  event: TimelineTimeLogInput["event"],
  minutes: number,
  extra: Partial<TimelineTimeLogInput> = {},
): TimelineTimeLogInput {
  return {
    event,
    atMs: at(minutes),
    reasonCode: null,
    actorId: "mem_cleaner",
    ...extra,
  };
}

function inspection(
  round: number,
  startMinutes: number,
  extra: Partial<TimelineInspectionInput> = {},
): TimelineInspectionInput {
  return {
    inspectionId: `insp_${String(round)}`,
    round,
    inspectorId: "mem_inspector",
    result: "PASS",
    startedAtMs: at(startMinutes),
    completedAtMs: at(startMinutes + 4),
    ...extra,
  };
}

function rework(
  round: number,
  extra: Partial<TimelineReworkInput> = {},
): TimelineReworkInput {
  return {
    reworkCycleId: `rwk_${String(round)}`,
    round,
    assignedToId: "mem_cleaner",
    status: "RESOLVED",
    startedAtMs: at(75),
    completedAtMs: at(79),
    waivedAtMs: null,
    ...extra,
  };
}

const EMPTY: EvidenceTimelineInput = { timeLogs: [], inspections: [], reworkCycles: [] };

describe("buildEvidenceTimeline: 出る行（正例）", () => {
  it("§12.3 の例がそのままの順で出る", () => {
    const result = buildEvidenceTimeline({
      timeLogs: [
        log("START", 12),
        log("PAUSE", 35, { reasonCode: "LINEN_SHORTAGE" }),
        log("RESUME", 42),
        log("COMPLETE", 62),
      ],
      inspections: [
        inspection(1, 68, { result: "FAIL", completedAtMs: at(72) }),
        inspection(2, 82, { result: "PASS", completedAtMs: at(84) }),
      ],
      reworkCycles: [rework(1, { startedAtMs: at(75), completedAtMs: at(79) })],
    });

    expect(result.map((entry) => entry.kind)).toEqual([
      "CLEANING_START",
      "CLEANING_PAUSE",
      "CLEANING_RESUME",
      "CLEANING_COMPLETE",
      "INSPECTION_START",
      "INSPECTION_FAIL",
      "REWORK_START",
      "REWORK_COMPLETE",
      "INSPECTION_START",
      "INSPECTION_PASS",
    ]);
  });

  it("中断の理由コードが行に残る", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      timeLogs: [log("PAUSE", 5, { reasonCode: "LINEN_SHORTAGE" })],
    });
    expect(result[0]?.reasonCode).toBe("LINEN_SHORTAGE");
  });

  it("入室不可と解除が出る", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      timeLogs: [log("UNBLOCK", 20), log("BLOCK", 10, { reasonCode: "GUEST_PRESENT" })],
    });
    expect(result.map((entry) => entry.kind)).toEqual(["TASK_BLOCK", "TASK_UNBLOCK"]);
  });

  it("免除は免除時刻の行として出る", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      reworkCycles: [
        rework(1, { status: "WAIVED", startedAtMs: null, completedAtMs: null, waivedAtMs: at(90) }),
      ],
    });
    expect(result.map((entry) => entry.kind)).toEqual(["REWORK_WAIVED"]);
    expect(result[0]?.atMs).toBe(at(90));
  });

  it("検査・差戻しの行がラウンドを持つ", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      inspections: [inspection(2, 10)],
      reworkCycles: [rework(3)],
    });
    expect(result.map((entry) => entry.round)).toEqual([2, 2, 3, 3]);
  });

  it("清掃の行はラウンドを持たない", () => {
    const result = buildEvidenceTimeline({ ...EMPTY, timeLogs: [log("START", 1)] });
    expect(result[0]?.round).toBeNull();
  });
});

describe("buildEvidenceTimeline: 出ない行（負例）", () => {
  it("完了していない検査の判定を出さない", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      inspections: [inspection(1, 10, { result: null, completedAtMs: null })],
    });
    expect(result.map((entry) => entry.kind)).toEqual(["INSPECTION_START"]);
  });

  it("完了時刻はあるが判定が無い検査の判定を出さない", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      inspections: [inspection(1, 10, { result: null })],
    });
    expect(result.map((entry) => entry.kind)).toEqual(["INSPECTION_START"]);
  });

  it("開始していない差戻しの開始を出さない", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      reworkCycles: [
        rework(1, { status: "OPEN", startedAtMs: null, completedAtMs: null }),
      ],
    });
    expect(result).toEqual([]);
  });

  it("未完了の差戻しの完了を出さない", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      reworkCycles: [rework(1, { status: "IN_PROGRESS", completedAtMs: null })],
    });
    expect(result.map((entry) => entry.kind)).toEqual(["REWORK_START"]);
  });

  it("免除時刻の無い免除を出さない", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      reworkCycles: [
        rework(1, { status: "WAIVED", startedAtMs: null, completedAtMs: null, waivedAtMs: null }),
      ],
    });
    expect(result).toEqual([]);
  });

  it("免除の行に担当者を載せない（免除は担当者の作業ではない）", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      reworkCycles: [
        rework(1, { status: "WAIVED", startedAtMs: null, completedAtMs: null, waivedAtMs: at(9) }),
      ],
    });
    expect(result[0]?.actorId).toBeNull();
  });

  it("所要時間・遅延の類を行に持たせない（§1.3）", () => {
    const result = buildEvidenceTimeline({
      ...EMPTY,
      timeLogs: [log("START", 0), log("COMPLETE", 50)],
    });
    for (const entry of result) {
      expect(Object.keys(entry).sort()).toEqual(["actorId", "atMs", "kind", "reasonCode", "round"]);
    }
  });
});

describe("buildEvidenceTimeline: 並びの決定性", () => {
  it("入力の順を変えても結果が同じ", () => {
    const forward = buildEvidenceTimeline({
      timeLogs: [log("START", 1), log("COMPLETE", 9)],
      inspections: [inspection(1, 12, { result: "FAIL", completedAtMs: at(15) })],
      reworkCycles: [rework(1, { startedAtMs: at(16), completedAtMs: at(20) })],
    });
    const reversed = buildEvidenceTimeline({
      timeLogs: [log("COMPLETE", 9), log("START", 1)],
      reworkCycles: [rework(1, { startedAtMs: at(16), completedAtMs: at(20) })],
      inspections: [inspection(1, 12, { result: "FAIL", completedAtMs: at(15) })],
    });
    expect(reversed).toEqual(forward);
  });

  it("同一ミリ秒は因果の順（検査不合格 → 再清掃開始）で出る", () => {
    const sameMs = at(30);
    const result = buildEvidenceTimeline({
      ...EMPTY,
      reworkCycles: [rework(1, { startedAtMs: sameMs, completedAtMs: at(40) })],
      inspections: [inspection(1, 25, { result: "FAIL", completedAtMs: sameMs })],
    });
    expect(result.map((entry) => entry.kind)).toEqual([
      "INSPECTION_START",
      "INSPECTION_FAIL",
      "REWORK_START",
      "REWORK_COMPLETE",
    ]);
  });

  it("空の入力は空", () => {
    expect(buildEvidenceTimeline(EMPTY)).toEqual([]);
  });

  it("種別の一覧に重複が無い", () => {
    expect(new Set(TIMELINE_KINDS).size).toBe(TIMELINE_KINDS.length);
  });
});
