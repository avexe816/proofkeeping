/**
 * R001 と R002 の統合（PK-SPEC-P4 §3.3 MUST / P4-12 の完了条件）。
 *
 * ルール: .claude/rules/testing.md §3
 *
 * ```
 * R001 と R002 が同一客室・同一業務日で同時に発生した場合、
 * 2 件を別々に出さず、R002 に統合して matchedSignals に両方の根拠を含める。
 * ```
 *
 * ── なぜ `evaluate()` の外から呼べるのか ────────────────
 * 統合は「差異の下書きの並び」に対する操作で、文脈を要らない。
 * **ここを純粋関数として切り出してあるので、組み合わせを網羅できる。**
 * `evaluate()` 越しの検証も下で 1 件だけ行う（配線の確認）。
 */

import { describe, expect, it } from "vitest";

import { MAX_CONFIDENCE, type FindingDraft } from "./types.js";
import { R001_R002_MERGE_BONUS, evaluate, mergeR001IntoR002 } from "./evaluate.js";
import { occupancyFact, observationFact, ruleContext, signalFact } from "./rules/testContext.js";

function draft(ruleCode: string, overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    ruleCode,
    severity: "MEDIUM",
    confidence: 50,
    title: `${ruleCode} のタイトル`,
    summary: "",
    evidence: {},
    matchedSignals: [`${ruleCode}_SIGNAL`],
    ...overrides,
  };
}

describe("mergeR001IntoR002 — 統合する（§3.3 MUST）", () => {
  it("2 件を 1 件にする", () => {
    const merged = mergeR001IntoR002([draft("R001"), draft("R002")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.ruleCode).toBe("R002");
  });

  it("**両方の根拠を残す**", () => {
    const merged = mergeR001IntoR002([
      draft("R001", { matchedSignals: ["BEDS_USED", "TRASH_PRESENT"] }),
      draft("R002", { matchedSignals: ["GUEST_KEY_UNLOCK"] }),
    ]);
    expect(merged[0]?.matchedSignals).toEqual([
      "GUEST_KEY_UNLOCK",
      "BEDS_USED",
      "TRASH_PRESENT",
    ]);
  });

  it("確信度に +25 する（§3.3「観察でも使用痕跡があるなら」）", () => {
    const merged = mergeR001IntoR002([draft("R001"), draft("R002", { confidence: 65 })]);
    expect(merged[0]?.confidence).toBe(65 + R001_R002_MERGE_BONUS);
  });

  it("100 を超えない", () => {
    const merged = mergeR001IntoR002([draft("R001"), draft("R002", { confidence: 95 })]);
    expect(merged[0]?.confidence).toBe(MAX_CONFIDENCE);
  });

  it("R001 の観察の根拠を R002 側へ移す", () => {
    const merged = mergeR001IntoR002([
      draft("R001", { evidence: { observation: { bedsUsed: 2 } } }),
      draft("R002", { evidence: { signals: [] } }),
    ]);
    expect(merged[0]?.evidence["observation"]).toEqual({ bedsUsed: 2 });
    expect(merged[0]?.evidence["mergedFrom"]).toEqual(["R001"]);
  });

  it("他のルールの並びを崩さない", () => {
    const merged = mergeR001IntoR002([
      draft("R001"),
      draft("R002"),
      draft("R012"),
      draft("R013"),
    ]);
    expect(merged.map((finding) => finding.ruleCode)).toEqual(["R002", "R012", "R013"]);
  });
});

describe("mergeR001IntoR002 — 統合しない", () => {
  it("R001 だけならそのまま", () => {
    const merged = mergeR001IntoR002([draft("R001")]);
    expect(merged.map((finding) => finding.ruleCode)).toEqual(["R001"]);
    expect(merged[0]?.confidence).toBe(50);
  });

  it("R002 だけならそのまま（加点しない）", () => {
    const merged = mergeR001IntoR002([draft("R002")]);
    expect(merged.map((finding) => finding.ruleCode)).toEqual(["R002"]);
    expect(merged[0]?.confidence).toBe(50);
  });

  it("どちらも無ければそのまま", () => {
    const merged = mergeR001IntoR002([draft("R012"), draft("R013")]);
    expect(merged.map((finding) => finding.ruleCode)).toEqual(["R012", "R013"]);
  });

  it("空なら空", () => {
    expect(mergeR001IntoR002([])).toEqual([]);
  });

  it("入力を書き換えない", () => {
    const input = [draft("R001"), draft("R002")];
    mergeR001IntoR002(input);
    expect(input).toHaveLength(2);
  });
});

describe("evaluate 越しの統合（配線）", () => {
  it("空室 × 使用痕跡 × 解錠 2 回で 1 件になる", () => {
    // R001（稼働記録なしの使用痕跡）と R002（解錠と記録の不一致）が
    // 同時に成り立つ文脈。
    const result = evaluate(
      ruleContext({
        occupancy: occupancyFact({ isOccupied: false, guestCount: 0, reservationRef: null }),
        observation: observationFact({ bedsUsed: 1, trashLevel: "NORMAL" }),
        signals: [signalFact(), signalFact()],
      }),
    );

    const codes = result.findings.map((finding) => finding.ruleCode);
    expect(codes).toContain("R002");
    expect(codes).not.toContain("R001");
    const merged = result.findings.find((finding) => finding.ruleCode === "R002");
    expect(merged?.matchedSignals).toContain("BEDS_USED");
  });
});
