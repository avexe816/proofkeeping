/**
 * 差戻しサイクルの状態機械（PK-SPEC-P2 §4.5〜§4.7）。
 *
 * task:  docs/tasks/P2-07.md
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  REWORK_ACTIONS,
  REWORK_STATUS_VALUES,
  checkWaiveRequirements,
  evaluateReworkTransition,
  isReworkSettled,
  reworkVisibleItemIds,
  type ReworkStatusValue,
} from "./reworkStatus.js";

describe("evaluateReworkTransition — 正例", () => {
  it("OPEN から start で IN_PROGRESS", () => {
    expect(evaluateReworkTransition("OPEN", "start")).toEqual({
      kind: "MOVE",
      to: "IN_PROGRESS",
    });
  });

  it("IN_PROGRESS から complete で RESOLVED", () => {
    expect(evaluateReworkTransition("IN_PROGRESS", "complete")).toEqual({
      kind: "MOVE",
      to: "RESOLVED",
    });
  });

  it("OPEN から waive で WAIVED（着手前でも免除できる）", () => {
    expect(evaluateReworkTransition("OPEN", "waive")).toEqual({ kind: "MOVE", to: "WAIVED" });
  });

  it("IN_PROGRESS から waive で WAIVED（作業中に設備故障が分かる場合）", () => {
    expect(evaluateReworkTransition("IN_PROGRESS", "waive")).toEqual({
      kind: "MOVE",
      to: "WAIVED",
    });
  });

  it("start の再送は NOOP（既に IN_PROGRESS）", () => {
    expect(evaluateReworkTransition("IN_PROGRESS", "start")).toEqual({ kind: "NOOP" });
  });

  it("complete の再送は NOOP（既に RESOLVED）", () => {
    expect(evaluateReworkTransition("RESOLVED", "complete")).toEqual({ kind: "NOOP" });
  });

  it("waive の再送は NOOP（既に WAIVED）", () => {
    expect(evaluateReworkTransition("WAIVED", "waive")).toEqual({ kind: "NOOP" });
  });
});

describe("evaluateReworkTransition — 負例", () => {
  it("OPEN から complete は拒否（開始していない再清掃は完了できない）", () => {
    expect(evaluateReworkTransition("OPEN", "complete")).toEqual({
      kind: "REJECTED",
      reason: "INVALID_TRANSITION",
    });
  });

  it("RESOLVED から start は拒否", () => {
    expect(evaluateReworkTransition("RESOLVED", "start")).toEqual({
      kind: "REJECTED",
      reason: "INVALID_TRANSITION",
    });
  });

  it("WAIVED から start は拒否", () => {
    expect(evaluateReworkTransition("WAIVED", "start")).toEqual({
      kind: "REJECTED",
      reason: "INVALID_TRANSITION",
    });
  });

  it("WAIVED から complete は拒否", () => {
    expect(evaluateReworkTransition("WAIVED", "complete")).toEqual({
      kind: "REJECTED",
      reason: "INVALID_TRANSITION",
    });
  });

  it("RESOLVED から waive は拒否（解決済みを免除に書き換えられない）", () => {
    expect(evaluateReworkTransition("RESOLVED", "waive")).toEqual({
      kind: "REJECTED",
      reason: "INVALID_TRANSITION",
    });
  });
});

describe("evaluateReworkTransition — 表そのもの", () => {
  it("全状態 × 全操作で例外を投げない", () => {
    for (const status of REWORK_STATUS_VALUES) {
      for (const action of REWORK_ACTIONS) {
        expect(() => evaluateReworkTransition(status, action)).not.toThrow();
      }
    }
  });

  it("決着した状態からは MOVE が出ない（reopen の経路が無い）", () => {
    const settled: ReworkStatusValue[] = ["RESOLVED", "WAIVED"];
    for (const status of settled) {
      for (const action of REWORK_ACTIONS) {
        expect(evaluateReworkTransition(status, action).kind).not.toBe("MOVE");
      }
    }
  });

  it("isReworkSettled は RESOLVED / WAIVED だけ真", () => {
    expect(isReworkSettled("OPEN")).toBe(false);
    expect(isReworkSettled("IN_PROGRESS")).toBe(false);
    expect(isReworkSettled("RESOLVED")).toBe(true);
    expect(isReworkSettled("WAIVED")).toBe(true);
  });
});

describe("reworkVisibleItemIds — §4.6「差戻し項目だけ」", () => {
  const item = (
    id: string,
    status: string | null,
    reworkRequired: boolean,
  ): { checklistItemId: string; status: string | null; reworkRequired: boolean } => ({
    checklistItemId: id,
    status,
    reworkRequired,
  });

  it("FAIL かつ reworkRequired だけを返す", () => {
    expect(
      reworkVisibleItemIds([
        item("a", "FAIL", true),
        item("b", "PASS", false),
        item("c", "FAIL", true),
      ]),
    ).toEqual(["a", "c"]);
  });

  it("PASS は出さない", () => {
    expect(reworkVisibleItemIds([item("a", "PASS", false)])).toEqual([]);
  });

  it("PASS に reworkRequired が立っていても出さない", () => {
    expect(reworkVisibleItemIds([item("a", "PASS", true)])).toEqual([]);
  });

  it("NOT_APPLICABLE は出さない", () => {
    expect(reworkVisibleItemIds([item("a", "NOT_APPLICABLE", true)])).toEqual([]);
  });

  it("未選択（null）は出さない", () => {
    expect(reworkVisibleItemIds([item("a", null, true)])).toEqual([]);
  });

  it("FAIL でも reworkRequired が false なら出さない", () => {
    expect(reworkVisibleItemIds([item("a", "FAIL", false)])).toEqual([]);
  });

  it("入力の順序を保つ（並べ替えない）", () => {
    expect(
      reworkVisibleItemIds([
        item("z", "FAIL", true),
        item("m", "FAIL", true),
        item("a", "FAIL", true),
      ]),
    ).toEqual(["z", "m", "a"]);
  });

  it("空の入力は空", () => {
    expect(reworkVisibleItemIds([])).toEqual([]);
  });
});

describe("checkWaiveRequirements — §4.7「理由必須・関連 IssueReport 必須」", () => {
  it("両方あれば ok", () => {
    expect(checkWaiveRequirements("シャワー混合栓の故障", "o7k2m9__issue_1")).toEqual({
      ok: true,
      missingReason: false,
      missingIssueReport: false,
    });
  });

  it("理由が無ければ落ちる", () => {
    expect(checkWaiveRequirements(null, "o7k2m9__issue_1").ok).toBe(false);
  });

  it("理由が空白だけでも落ちる", () => {
    expect(checkWaiveRequirements("   ", "o7k2m9__issue_1").missingReason).toBe(true);
  });

  it("関連 Issue が無ければ落ちる", () => {
    expect(checkWaiveRequirements("故障", null).missingIssueReport).toBe(true);
  });

  it("両方欠けたら両方を返す（往復を作らない）", () => {
    expect(checkWaiveRequirements("", "")).toEqual({
      ok: false,
      missingReason: true,
      missingIssueReport: true,
    });
  });
});
