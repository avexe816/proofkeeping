/**
 * 状態機械（PK-SPEC-P1 §5.1 / §5.3）。
 */

import { describe, expect, it } from "vitest";

import {
  TASK_ACTIONS,
  TASK_STATUS_VALUES,
  evaluateTransition,
  requiresReasonCode,
  timeEventOf,
  type TaskStatusValue,
} from "./taskStatus.js";

describe("evaluateTransition — 正例（§5.1 の図）", () => {
  it("CREATED から assign で ASSIGNED", () => {
    expect(evaluateTransition("CREATED", "assign", false)).toEqual({
      kind: "MOVE",
      to: "ASSIGNED",
    });
  });

  it("ASSIGNED から start で IN_PROGRESS", () => {
    expect(evaluateTransition("ASSIGNED", "start", false)).toEqual({
      kind: "MOVE",
      to: "IN_PROGRESS",
    });
  });

  it("IN_PROGRESS から pause で PAUSED", () => {
    expect(evaluateTransition("IN_PROGRESS", "pause", false)).toEqual({
      kind: "MOVE",
      to: "PAUSED",
    });
  });

  it("PAUSED から resume で IN_PROGRESS", () => {
    expect(evaluateTransition("PAUSED", "resume", false)).toEqual({
      kind: "MOVE",
      to: "IN_PROGRESS",
    });
  });

  it("REWORK から start できる（P2 の差戻し後）", () => {
    expect(evaluateTransition("REWORK", "start", false)).toEqual({
      kind: "MOVE",
      to: "IN_PROGRESS",
    });
  });

  it("BLOCKED から unblock で ASSIGNED へ戻る", () => {
    expect(evaluateTransition("BLOCKED", "unblock", false)).toEqual({
      kind: "MOVE",
      to: "ASSIGNED",
    });
  });
});

describe("evaluateTransition — 検査の要否で complete の行き先が変わる（§5.2）", () => {
  it("検査不要の施設では COMPLETED まで進む", () => {
    expect(evaluateTransition("IN_PROGRESS", "complete", false)).toEqual({
      kind: "MOVE",
      to: "COMPLETED",
    });
  });

  it("検査必要の施設では AWAITING_INSPECTION で止まる", () => {
    expect(evaluateTransition("IN_PROGRESS", "complete", true)).toEqual({
      kind: "MOVE",
      to: "AWAITING_INSPECTION",
    });
  });
});

describe("evaluateTransition — 負例", () => {
  it("CREATED から start できない（割当が先）", () => {
    expect(evaluateTransition("CREATED", "start", false)).toEqual({
      kind: "REJECTED",
      reason: "INVALID_TRANSITION",
    });
  });

  it("ASSIGNED から complete できない（着手が先）", () => {
    expect(evaluateTransition("ASSIGNED", "complete", false).kind).toBe("REJECTED");
  });

  it("COMPLETED から start できない", () => {
    expect(evaluateTransition("COMPLETED", "start", false).kind).toBe("REJECTED");
  });

  it("IN_PROGRESS から cancel できない（§5.3 は CREATED / ASSIGNED / BLOCKED のみ）", () => {
    expect(evaluateTransition("IN_PROGRESS", "cancel", false).kind).toBe("REJECTED");
  });

  it("CANCELLED から assign できない", () => {
    expect(evaluateTransition("CANCELLED", "assign", false).kind).toBe("REJECTED");
  });

  it("PAUSED から pause できない（既に中断中は NOOP、二重中断ではない）", () => {
    expect(evaluateTransition("PAUSED", "pause", false)).toEqual({ kind: "NOOP" });
  });
});

describe("evaluateTransition — 再送は成功として扱う（§8.2）", () => {
  it.each([
    ["IN_PROGRESS", "start"],
    ["PAUSED", "pause"],
    ["BLOCKED", "block"],
    ["CANCELLED", "cancel"],
    ["COMPLETED", "complete"],
    ["AWAITING_INSPECTION", "complete"],
  ] as const)("%s への %s は NOOP", (from, action) => {
    expect(evaluateTransition(from, action, false)).toEqual({ kind: "NOOP" });
  });

  it("同じ start を 3 回評価しても状態が進まない", () => {
    let status: TaskStatusValue = "ASSIGNED";
    for (let i = 0; i < 3; i++) {
      const result = evaluateTransition(status, "start", false);
      if (result.kind === "MOVE") status = result.to;
    }

    expect(status).toBe("IN_PROGRESS");
  });
});

describe("表の網羅", () => {
  it("全状態 × 全操作が例外なく判定できる", () => {
    for (const status of TASK_STATUS_VALUES) {
      for (const action of TASK_ACTIONS) {
        expect(["MOVE", "NOOP", "REJECTED"]).toContain(
          evaluateTransition(status, action, false).kind,
        );
      }
    }
  });

  it("時間ログを持つ操作と持たない操作が分かれている", () => {
    expect(timeEventOf("start")).toBe("START");
    expect(timeEventOf("complete")).toBe("COMPLETE");
    // 作業時間に関係しない操作。`TimeEvent` に対応する値が無い（§2.1）。
    expect(timeEventOf("assign")).toBeNull();
    expect(timeEventOf("cancel")).toBeNull();
  });

  it("理由コードが必須なのは pause と block だけ（§5.3）", () => {
    const required = TASK_ACTIONS.filter((action) => requiresReasonCode(action));

    expect(required).toEqual(["pause", "block"]);
  });
});
