/**
 * スタッフ支払集計（P5-18 / docs/PK-SPEC-PAY.md §2）。
 *
 * testing.md §3: すべてのルール・計算に正例と負例を最低 5 件ずつ。
 */

import { describe, expect, it } from "vitest";

import {
  buildPayoutDraft,
  resolvePayRule,
  type PayableWork,
  type PayRuleCandidate,
} from "./payout.js";

function rule(overrides: Partial<PayRuleCandidate> & { id: string }): PayRuleCandidate {
  return {
    membershipId: null,
    propertyId: null,
    taskType: null,
    unitType: "PER_TASK",
    unitPrice: 1500,
    validFrom: null,
    validTo: null,
    priority: 100,
    ...overrides,
  };
}

function work(overrides: Partial<PayableWork> & { taskId: string }): PayableWork {
  return {
    membershipId: "mem_a",
    propertyId: "prop_1",
    propertyName: "テスト施設",
    taskType: "CHECKOUT",
    businessDate: "2026-08-01",
    actualMinutes: 45,
    ...overrides,
  };
}

describe("resolvePayRule: 5 段階の優先順位（PAY §1.2）", () => {
  const rules = [
    rule({ id: "r5" }), // 全体既定
    rule({ id: "r4", propertyId: "prop_1", taskType: "CHECKOUT" }),
    rule({ id: "r3", membershipId: "mem_a" }),
    rule({ id: "r2", membershipId: "mem_a", taskType: "CHECKOUT" }),
    rule({ id: "r1", membershipId: "mem_a", propertyId: "prop_1", taskType: "CHECKOUT" }),
  ];

  // ── 正例 ────────────────────────────────────────────────
  it("1: スタッフ＋施設＋種別の一致が最優先", () => {
    expect(resolvePayRule(rules, work({ taskId: "t" }))?.rule.id).toBe("r1");
  });

  it("2: 施設が違えばスタッフ＋種別", () => {
    expect(resolvePayRule(rules, work({ taskId: "t", propertyId: "prop_2" }))?.rule.id).toBe("r2");
  });

  it("3: 種別も違えばスタッフ既定", () => {
    expect(
      resolvePayRule(rules, work({ taskId: "t", propertyId: "prop_2", taskType: "DEEP" }))?.rule.id,
    ).toBe("r3");
  });

  it("4: スタッフの行が無ければ施設＋種別", () => {
    expect(resolvePayRule(rules, work({ taskId: "t", membershipId: "mem_b" }))?.rule.id).toBe("r4");
  });

  it("5: どれも無ければ全体既定", () => {
    expect(
      resolvePayRule(
        rules,
        work({ taskId: "t", membershipId: "mem_b", propertyId: "prop_2", taskType: "DEEP" }),
      )?.rule.id,
    ).toBe("r5");
  });

  it("同じ段では priority の小さいほうが勝つ（DECISIONS #122 の向き）", () => {
    const tied = [
      rule({ id: "a", membershipId: "mem_a", priority: 200 }),
      rule({ id: "b", membershipId: "mem_a", priority: 100 }),
    ];
    expect(resolvePayRule(tied, work({ taskId: "t" }))?.rule.id).toBe("b");
  });

  // ── 負例 ────────────────────────────────────────────────
  it("該当が 1 件も無ければ null（0 円計上は buildPayoutDraft の責務）", () => {
    expect(resolvePayRule([], work({ taskId: "t" }))).toBeNull();
  });

  it("有効期間の前は採らない", () => {
    const future = [rule({ id: "r", validFrom: "2026-09-01" })];
    expect(resolvePayRule(future, work({ taskId: "t", businessDate: "2026-08-31" }))).toBeNull();
  });

  it("有効期間の後は採らない", () => {
    const past = [rule({ id: "r", validTo: "2026-07-31" })];
    expect(resolvePayRule(past, work({ taskId: "t", businessDate: "2026-08-01" }))).toBeNull();
  });

  it("別スタッフの単価は採らない", () => {
    const other = [rule({ id: "r", membershipId: "mem_b" })];
    expect(resolvePayRule(other, work({ taskId: "t" }))).toBeNull();
  });

  it("段として表せない組み合わせ（施設のみ）は採らない", () => {
    const odd = [rule({ id: "r", propertyId: "prop_1" })];
    expect(resolvePayRule(odd, work({ taskId: "t" }))).toBeNull();
  });

  it("境界日は含む（validFrom / validTo の当日）", () => {
    const bounded = [rule({ id: "r", validFrom: "2026-08-01", validTo: "2026-08-31" })];
    expect(resolvePayRule(bounded, work({ taskId: "t", businessDate: "2026-08-01" }))).not.toBeNull();
    expect(resolvePayRule(bounded, work({ taskId: "t", businessDate: "2026-08-31" }))).not.toBeNull();
  });
});

describe("buildPayoutDraft: 明細の組み立て（PAY §2）", () => {
  // ── 正例 ────────────────────────────────────────────────
  it("PER_TASK は件数 × 単価", () => {
    const draft = buildPayoutDraft({
      works: [work({ taskId: "t1" }), work({ taskId: "t2" }), work({ taskId: "t3" })],
      rules: [rule({ id: "r", unitPrice: 1800 })],
    });
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ quantity: 3, unitPrice: 1800, amount: 5400 });
    expect(draft.totalAmount).toBe(5400);
    expect(draft.warnings).toEqual([]);
  });

  it("HOURLY は実働分 × 時給を行ごとに 1 回だけ切り捨て", () => {
    const draft = buildPayoutDraft({
      works: [
        work({ taskId: "t1", actualMinutes: 25 }),
        work({ taskId: "t2", actualMinutes: 26 }),
      ],
      rules: [rule({ id: "r", unitType: "HOURLY", unitPrice: 1300 })],
    });
    // 51 分 × 1300 / 60 = 1105（タスクごとに丸めると 541 + 563 = 1104 になる）。
    expect(draft.lines[0]).toMatchObject({ quantity: 51, amount: 1105 });
  });

  it("施設 × 種別 × 単価でグループされる", () => {
    const draft = buildPayoutDraft({
      works: [
        work({ taskId: "t1" }),
        work({ taskId: "t2", taskType: "STAYOVER" }),
        work({ taskId: "t3", propertyId: "prop_2", propertyName: "第二施設" }),
      ],
      rules: [rule({ id: "r" })],
    });
    expect(draft.lines).toHaveLength(3);
    expect(draft.lines.map((line) => line.lineNo)).toEqual([1, 2, 3]);
  });

  it("description は 施設名 / 清掃種別（請求明細と同じ形）", () => {
    const draft = buildPayoutDraft({
      works: [work({ taskId: "t1" })],
      rules: [rule({ id: "r" })],
    });
    expect(draft.lines[0]?.description).toContain("テスト施設 / ");
  });

  it("taskIds に集計元が残る（証跡ドリルダウン / PAY §1.4）", () => {
    const draft = buildPayoutDraft({
      works: [work({ taskId: "t2" }), work({ taskId: "t1" })],
      rules: [rule({ id: "r" })],
    });
    expect(draft.lines[0]?.taskIds).toEqual(["t1", "t2"]);
  });

  it("同じ入力から同じ結果（再計算方式の冪等 / testing.md §4）", () => {
    const input = {
      works: [
        work({ taskId: "t3", propertyId: "prop_2", propertyName: "第二施設" }),
        work({ taskId: "t1" }),
        work({ taskId: "t2", taskType: "STAYOVER" }),
      ],
      rules: [rule({ id: "r" })],
    };
    const first = buildPayoutDraft(input);
    const second = buildPayoutDraft({
      ...input,
      works: [...input.works].reverse(),
    });
    const third = buildPayoutDraft(input);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  // ── 負例 ────────────────────────────────────────────────
  it("単価が引けないタスクは 0 円計上＋警告（黙って除外しない / PAY §1.2）", () => {
    const draft = buildPayoutDraft({
      works: [work({ taskId: "t1" }), work({ taskId: "t2" })],
      rules: [],
    });
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({
      quantity: 2,
      unitPrice: 0,
      amount: 0,
      warning: "NO_PAY_RULE",
    });
    expect(draft.warnings).toEqual([{ code: "NO_PAY_RULE", count: 2 }]);
  });

  it("HOURLY で時間ログが無いタスクは 0 分＋警告", () => {
    const draft = buildPayoutDraft({
      works: [
        work({ taskId: "t1", actualMinutes: 60 }),
        work({ taskId: "t2", actualMinutes: null }),
      ],
      rules: [rule({ id: "r", unitType: "HOURLY", unitPrice: 1200 })],
    });
    expect(draft.lines[0]).toMatchObject({ quantity: 60, amount: 1200, warning: "NO_TIME_LOG" });
    expect(draft.warnings).toEqual([{ code: "NO_TIME_LOG", count: 1 }]);
  });

  it("タスクが無ければ空（明細 0 行・合計 0 円）", () => {
    const draft = buildPayoutDraft({ works: [], rules: [rule({ id: "r" })] });
    expect(draft.lines).toEqual([]);
    expect(draft.totalAmount).toBe(0);
  });

  it("金額は常に整数（浮動小数点を持ち込まない / billing.md §4）", () => {
    const draft = buildPayoutDraft({
      works: [work({ taskId: "t1", actualMinutes: 7 })],
      rules: [rule({ id: "r", unitType: "HOURLY", unitPrice: 1234 })],
    });
    // 7 × 1234 / 60 = 143.96… → 143。
    expect(draft.lines[0]?.amount).toBe(143);
    expect(Number.isInteger(draft.totalAmount)).toBe(true);
  });

  it("別スタッフの単価行が混ざっていても効かない", () => {
    const draft = buildPayoutDraft({
      works: [work({ taskId: "t1" })],
      rules: [rule({ id: "r", membershipId: "mem_b", unitPrice: 9999 })],
    });
    expect(draft.lines[0]).toMatchObject({ unitPrice: 0, warning: "NO_PAY_RULE" });
  });
});
