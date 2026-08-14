/**
 * R010 — 客室ステータスの手動上書き頻発（PK-SPEC-P4 §3.8）。
 *
 * ルール: .claude/rules/testing.md §3 / .claude/rules/security.md §5
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - **`summary` に「業務手順の見直しが必要な可能性」がある**（§3.8 MUST /
 *     P4-12 の完了条件）
 *   - 氏名を根拠に入れない（security.md §5 / INV-07）
 *   - 施設全体で数え、当日その客室を触った人だけに立てる
 */

import { describe, expect, it } from "vitest";

import type { StatusOverrideFact } from "../types.js";

import { R010, R010_CONFIDENCE, R010_THRESHOLD, overrideCountsByActor } from "./R010.js";
import { TEST_MEMBERSHIP_ID, TEST_ROOM_ID, ruleContext } from "./testContext.js";

const OTHER_ACTOR = "o7k2m9__mem_01JBXQ3ZK8N4P2VYR6ZZZZZZ";
const OTHER_ROOM = "o7k2m9__room_01JBXQ3ZK8N4P2VYR6ZZZZZZ";

function override(overrides: Partial<StatusOverrideFact> = {}): StatusOverrideFact {
  return {
    roomId: OTHER_ROOM,
    actorId: TEST_MEMBERSHIP_ID,
    at: Date.parse("2026-09-08T10:00:00+09:00"),
    toStatus: "READY",
    ...overrides,
  };
}

/** 同じ人が施設全体で N 件。うち 1 件は当日この客室。 */
function overrides(count: number, actorId = TEST_MEMBERSHIP_ID): StatusOverrideFact[] {
  const rows = Array.from({ length: count - 1 }, () => override({ actorId }));
  rows.push(override({ actorId, roomId: TEST_ROOM_ID }));
  return rows;
}

describe("R010 — 正例（差異になる）", () => {
  it("5 回以上で差異になる", () => {
    const finding = R010.evaluate(ruleContext({ statusOverrides: overrides(R010_THRESHOLD) }));
    expect(finding?.ruleCode).toBe("R010");
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("確信度は固定 60（§3.8）", () => {
    const finding = R010.evaluate(ruleContext({ statusOverrides: overrides(9) }));
    expect(finding?.confidence).toBe(R010_CONFIDENCE);
  });

  it("**「業務手順の見直しが必要な可能性」を必ず併記する**（§3.8 MUST）", () => {
    const finding = R010.evaluate(ruleContext({ statusOverrides: overrides(R010_THRESHOLD) }));
    expect(finding?.summary).toContain("業務手順の見直しが必要な可能性");
  });

  it("氏名を根拠に入れない（security.md §5）", () => {
    const finding = R010.evaluate(ruleContext({ statusOverrides: overrides(R010_THRESHOLD) }));
    expect(finding?.evidence["actorId"]).toBe(TEST_MEMBERSHIP_ID);
    expect(Object.keys(finding?.evidence ?? {})).not.toContain("actorName");
  });

  it("件数を根拠に残す", () => {
    const finding = R010.evaluate(ruleContext({ statusOverrides: overrides(7) }));
    expect(finding?.evidence["overrideCount"]).toBe(7);
  });

  it("3 系統がどれも無くても動く（根拠は監査ログ）", () => {
    const finding = R010.evaluate(
      ruleContext({
        occupancy: null,
        observation: null,
        statusOverrides: overrides(R010_THRESHOLD),
      }),
    );
    expect(finding).not.toBeNull();
    expect(R010.requires).toEqual([]);
  });
});

describe("R010 — 負例（差異にしない）", () => {
  it("4 回では差異にしない", () => {
    expect(R010.evaluate(ruleContext({ statusOverrides: overrides(4) }))).toBeNull();
  });

  it("上書きが 1 件も無ければ差異にしない", () => {
    expect(R010.evaluate(ruleContext({ statusOverrides: [] }))).toBeNull();
  });

  it("**その客室を触っていない人の分は立てない**（差異を置く場所が無い）", () => {
    const rows = Array.from({ length: 9 }, () => override());
    expect(R010.evaluate(ruleContext({ statusOverrides: rows }))).toBeNull();
  });

  it("別々の人が 5 件ずつでも、1 人あたりが閾値未満なら差異にしない", () => {
    const rows = [
      ...Array.from({ length: 4 }, () => override({ actorId: TEST_MEMBERSHIP_ID })),
      ...Array.from({ length: 4 }, () => override({ actorId: OTHER_ACTOR })),
      override({ actorId: TEST_MEMBERSHIP_ID, roomId: TEST_ROOM_ID }),
    ];
    // TEST_MEMBERSHIP_ID は 5 件（4 + 当日の 1）なので差異になる。
    expect(R010.evaluate(ruleContext({ statusOverrides: rows }))).not.toBeNull();

    const fewer = rows.slice(1);
    expect(R010.evaluate(ruleContext({ statusOverrides: fewer }))).toBeNull();
  });

  it("`READY` 以外への上書きは数えない", () => {
    const rows = Array.from({ length: 9 }, () => override({ toStatus: "DIRTY" }));
    rows.push(override({ roomId: TEST_ROOM_ID, toStatus: "DIRTY" }));
    expect(R010.evaluate(ruleContext({ statusOverrides: rows }))).toBeNull();
  });
});

describe("overrideCountsByActor", () => {
  it("`READY` への上書きだけを人ごとに数える", () => {
    const counts = overrideCountsByActor([
      override({ actorId: "A" }),
      override({ actorId: "A" }),
      override({ actorId: "B" }),
      override({ actorId: "A", toStatus: "DIRTY" }),
    ]);
    expect(counts.get("A")).toBe(2);
    expect(counts.get("B")).toBe(1);
  });

  it("空なら空", () => {
    expect(overrideCountsByActor([]).size).toBe(0);
  });
});
