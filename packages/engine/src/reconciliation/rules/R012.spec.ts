/**
 * R012 — 写真未添付での完了（PK-SPEC-P4 §3.1）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 完了していて写真が 0 枚のときだけ
 *   - **重要度は LOW**（証跡が薄いという事実で、作業の良し悪しではない）
 *   - 3 系統がどれも無くても動く（根拠はタスク）
 */

import { describe, expect, it } from "vitest";

import { R012, R012_CONFIDENCE } from "./R012.js";
import { ruleContext } from "./testContext.js";

function task(overrides: Record<string, unknown> = {}) {
  return {
    taskType: "CHECKOUT",
    isCompleted: true,
    startedAt: null,
    completedAt: Date.parse("2026-09-09T13:00:00+09:00"),
    actualMinutes: 40,
    photoCount: 0,
    ...overrides,
  };
}

describe("R012 — 正例（差異になる）", () => {
  it("完了しているのに写真が 0 枚なら差異", () => {
    const finding = R012.evaluate(ruleContext({ task: task() }));
    expect(finding?.ruleCode).toBe("R012");
  });

  it("重要度は LOW", () => {
    expect(R012.evaluate(ruleContext({ task: task() }))?.severity).toBe("LOW");
  });

  it("確信度は固定", () => {
    expect(R012.evaluate(ruleContext({ task: task() }))?.confidence).toBe(R012_CONFIDENCE);
  });

  it("3 系統がどれも無くても動く", () => {
    const finding = R012.evaluate(
      ruleContext({ occupancy: null, observation: null, task: task() }),
    );
    expect(finding).not.toBeNull();
    expect(R012.requires).toEqual([]);
  });

  it("作業種別を問わない（滞在中清掃でも立つ）", () => {
    expect(R012.evaluate(ruleContext({ task: task({ taskType: "STAY" }) }))).not.toBeNull();
  });

  it("根拠に枚数と完了時刻を残す", () => {
    const finding = R012.evaluate(ruleContext({ task: task() }));
    expect(finding?.evidence["task"]).toMatchObject({ photoCount: 0 });
    expect(finding?.matchedSignals).toEqual(["NO_PHOTO_ON_COMPLETION"]);
  });
});

describe("R012 — 負例（差異にしない）", () => {
  it("写真が 1 枚でもあれば差異にしない", () => {
    expect(R012.evaluate(ruleContext({ task: task({ photoCount: 1 }) }))).toBeNull();
  });

  it("完了していなければ差異にしない", () => {
    expect(R012.evaluate(ruleContext({ task: task({ isCompleted: false }) }))).toBeNull();
  });

  it("タスクが無ければ差異にしない", () => {
    expect(R012.evaluate(ruleContext({ task: null }))).toBeNull();
  });

  it("進行中のタスクは写真が 0 でも差異にしない", () => {
    expect(
      R012.evaluate(ruleContext({ task: task({ isCompleted: false, completedAt: null }) })),
    ).toBeNull();
  });

  it("写真が多数あれば差異にしない", () => {
    expect(R012.evaluate(ruleContext({ task: task({ photoCount: 5 }) }))).toBeNull();
  });
});
