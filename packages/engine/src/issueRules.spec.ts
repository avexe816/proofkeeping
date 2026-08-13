/**
 * 設備不具合の規則のテスト（PK-SPEC-P2 §8.2・§8.3）。
 *
 * task:  docs/tasks/P2-12.md
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ここでの「負例」は**自動で戻さないこと。** §8.3 の
 * 「不具合を閉じても客室状態は自動復旧しない」は、規則の側に
 * 「戻してよい」を返す口が無いことで守る。
 */

import { describe, expect, it } from "vitest";

import {
  ISSUE_SEVERITY_VALUES,
  ISSUE_STATUS_VALUES,
  canTransitionIssue,
  evaluateIssueTransition,
  isTerminalIssueStatus,
  requiresConfirmation,
  roomEffectOf,
} from "./issueRules.js";

describe("roomEffectOf（§8.2 の表）", () => {
  it("LOW は販売可（何もしない）", () => {
    expect(roomEffectOf("LOW")).toBe("NONE");
  });

  it("MEDIUM は責任者判断", () => {
    expect(roomEffectOf("MEDIUM")).toBe("ASK_MANAGER");
  });

  it("HIGH は「原則 BLOCKED」＝勧めるだけ（自動で止めない）", () => {
    expect(roomEffectOf("HIGH")).toBe("SUGGEST_BLOCK");
    expect(roomEffectOf("HIGH")).not.toBe("AUTO_BLOCK");
  });

  it("CRITICAL だけが自動で止める", () => {
    expect(roomEffectOf("CRITICAL")).toBe("AUTO_BLOCK");
    const auto = ISSUE_SEVERITY_VALUES.filter((s) => roomEffectOf(s) === "AUTO_BLOCK");
    expect(auto).toEqual(["CRITICAL"]);
  });

  it("全重要度が値を返す", () => {
    for (const severity of ISSUE_SEVERITY_VALUES) {
      expect(roomEffectOf(severity), severity).toBeDefined();
    }
  });
});

describe("requiresConfirmation（§8.2 MUST）", () => {
  it("CRITICAL は確認画面が要る", () => {
    expect(requiresConfirmation("CRITICAL")).toBe(true);
  });

  it.each(["LOW", "MEDIUM", "HIGH"] as const)("%s は確認画面を挟まない", (severity) => {
    // ui-writing.md §3「主要操作は 1 タップ。確認ダイアログを挟まない」。
    expect(requiresConfirmation(severity)).toBe(false);
  });
});

describe("canTransitionIssue（§3.6）", () => {
  it("OPEN から進める先", () => {
    expect(canTransitionIssue("OPEN", "ACKNOWLEDGED")).toBe(true);
    expect(canTransitionIssue("OPEN", "IN_PROGRESS")).toBe(true);
    expect(canTransitionIssue("OPEN", "RESOLVED")).toBe(true);
    expect(canTransitionIssue("OPEN", "WONT_FIX")).toBe(true);
  });

  it("解決から閉じる / 直っていなければ着手へ戻る", () => {
    expect(canTransitionIssue("RESOLVED", "CLOSED")).toBe(true);
    expect(canTransitionIssue("RESOLVED", "IN_PROGRESS")).toBe(true);
  });

  it("CLOSED は終端（開き直せない）", () => {
    for (const to of ISSUE_STATUS_VALUES) {
      expect(canTransitionIssue("CLOSED", to), to).toBe(false);
    }
    expect(isTerminalIssueStatus("CLOSED")).toBe(true);
  });

  it("WONT_FIX も終端", () => {
    for (const to of ISSUE_STATUS_VALUES) {
      expect(canTransitionIssue("WONT_FIX", to), to).toBe(false);
    }
    expect(isTerminalIssueStatus("WONT_FIX")).toBe(true);
  });

  it("着手したら OPEN へは戻せない", () => {
    expect(canTransitionIssue("IN_PROGRESS", "OPEN")).toBe(false);
    expect(canTransitionIssue("ACKNOWLEDGED", "OPEN")).toBe(false);
  });

  it("OPEN から CLOSED へ飛べない（解決を経る）", () => {
    expect(canTransitionIssue("OPEN", "CLOSED")).toBe(false);
  });

  it("終端でない状態は必ず進める先を持つ", () => {
    for (const status of ISSUE_STATUS_VALUES) {
      if (isTerminalIssueStatus(status)) continue;
      const next = ISSUE_STATUS_VALUES.filter((to) => canTransitionIssue(status, to));
      expect(next.length, status).toBeGreaterThan(0);
    }
  });
});

describe("evaluateIssueTransition（§8.3）", () => {
  it("同じ状態への遷移は NOOP（再送を成功扱い）", () => {
    expect(evaluateIssueTransition({ from: "OPEN", to: "OPEN", resolutionNote: null })).toEqual({
      kind: "NOOP",
    });
  });

  it("許された遷移は OK", () => {
    expect(
      evaluateIssueTransition({ from: "OPEN", to: "ACKNOWLEDGED", resolutionNote: null }),
    ).toEqual({ kind: "OK" });
  });

  it("RESOLVED には解決内容が要る", () => {
    expect(
      evaluateIssueTransition({ from: "IN_PROGRESS", to: "RESOLVED", resolutionNote: null }),
    ).toEqual({ kind: "REJECTED", reason: "RESOLUTION_NOTE_REQUIRED" });
  });

  it("空白だけの解決内容は通さない", () => {
    expect(
      evaluateIssueTransition({ from: "IN_PROGRESS", to: "RESOLVED", resolutionNote: "  \n " }),
    ).toEqual({ kind: "REJECTED", reason: "RESOLUTION_NOTE_REQUIRED" });
  });

  it("解決内容があれば RESOLVED へ進める", () => {
    expect(
      evaluateIssueTransition({
        from: "IN_PROGRESS",
        to: "RESOLVED",
        resolutionNote: "止水栓を締め、業者へ手配した",
      }),
    ).toEqual({ kind: "OK" });
  });

  it("許されない遷移は INVALID_TRANSITION", () => {
    expect(evaluateIssueTransition({ from: "CLOSED", to: "OPEN", resolutionNote: null })).toEqual({
      kind: "REJECTED",
      reason: "INVALID_TRANSITION",
    });
  });

  it("WONT_FIX には解決内容を要求しない（直さないと決めた記録）", () => {
    expect(evaluateIssueTransition({ from: "OPEN", to: "WONT_FIX", resolutionNote: null })).toEqual({
      kind: "OK",
    });
  });

  it("客室を戻してよいかを返さない（§8.3）", () => {
    const result = evaluateIssueTransition({
      from: "RESOLVED",
      to: "CLOSED",
      resolutionNote: "完了",
    });
    expect(Object.keys(result)).toEqual(["kind"]);
  });
});
