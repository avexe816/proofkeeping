/**
 * 差異一覧の並び（P4-06 / PK-SPEC-P4 §6.1）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例）
 *
 * ── なぜ並びをテストするのか ────────────────────────────
 * §6.1 の表は「重要度が高い順・新しい順」。**リポジトリでは並べられない**
 * （`severity` は text で、昇順が `HIGH < LOW < MEDIUM` になる /
 * `listFindings()` の注記）。並べ直しはこの関数 1 つに閉じているので、
 * ここが崩れると画面の並びが黙って辞書順へ戻る。
 */

import { describe, expect, it } from "vitest";

import type { FindingSummary } from "@pk/contracts";

import { compareFindingsForDisplay } from "./findings.js";

const BASE: FindingSummary = {
  id: "a1b2c3__find_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  propertyId: "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  propertyName: "テスト施設",
  roomId: "a1b2c3__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
  roomNumber: "302",
  businessDate: "2026-09-09",
  ruleCode: "R001",
  severity: "MEDIUM",
  confidence: 60,
  title: "302 号室：稼働記録のない使用痕跡",
  status: "OPEN",
  resolutionCode: null,
  createdAt: 1_760_000_000_000,
};

function finding(overrides: Partial<FindingSummary>): FindingSummary {
  return { ...BASE, ...overrides };
}

/** 並べた結果の ID 列。**`sort()` を通すのは安定性も見るため。** */
function orderOf(rows: readonly FindingSummary[]): string[] {
  return [...rows].sort(compareFindingsForDisplay).map((row) => row.id);
}

describe("compareFindingsForDisplay — §6.1 の並び", () => {
  it("重要度が最優先（高 → 中 → 低）", () => {
    const rows = [
      finding({ id: "low", severity: "LOW" }),
      finding({ id: "high", severity: "HIGH" }),
      finding({ id: "medium", severity: "MEDIUM" }),
    ];
    expect(orderOf(rows)).toEqual(["high", "medium", "low"]);
  });

  it("辞書順にならない（HIGH < LOW < MEDIUM を避ける）", () => {
    const rows = [
      finding({ id: "medium", severity: "MEDIUM" }),
      finding({ id: "low", severity: "LOW" }),
    ];
    // text の昇順なら LOW が先に来る。**語彙の順序で並べていることの確認。**
    expect(orderOf(rows)).toEqual(["medium", "low"]);
  });

  it("同じ重要度なら業務日が新しい順", () => {
    const rows = [
      finding({ id: "old", businessDate: "2026-09-01" }),
      finding({ id: "new", businessDate: "2026-09-09" }),
    ];
    expect(orderOf(rows)).toEqual(["new", "old"]);
  });

  it("同じ業務日なら確信度が高い順", () => {
    const rows = [
      finding({ id: "weak", confidence: 40 }),
      finding({ id: "strong", confidence: 85 }),
    ];
    expect(orderOf(rows)).toEqual(["strong", "weak"]);
  });

  it("すべて同じなら ID 順（呼ぶたびに並びが変わらない）", () => {
    const rows = [finding({ id: "b" }), finding({ id: "a" }), finding({ id: "c" })];
    expect(orderOf(rows)).toEqual(["a", "b", "c"]);
    expect(orderOf(rows)).toEqual(orderOf(rows));
  });

  it("重要度は日付より強い（古い HIGH が新しい LOW より先）", () => {
    const rows = [
      finding({ id: "newLow", severity: "LOW", businessDate: "2026-09-09" }),
      finding({ id: "oldHigh", severity: "HIGH", businessDate: "2026-08-01" }),
    ];
    expect(orderOf(rows)).toEqual(["oldHigh", "newLow"]);
  });

  it("状態では並べ替えない（解決済が下へ落ちない）", () => {
    // §6.1 の表は状態で並べていない。**絞り込みはフィルタの仕事。**
    const rows = [
      finding({ id: "resolvedHigh", severity: "HIGH", status: "RESOLVED" }),
      finding({ id: "openLow", severity: "LOW", status: "OPEN" }),
    ];
    expect(orderOf(rows)).toEqual(["resolvedHigh", "openLow"]);
  });
});
