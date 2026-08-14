/**
 * 料金の解決の検査（PK-SPEC-P5 §3.2）。
 *
 * task:  docs/tasks/P5-03.md
 * ルール: .claude/rules/testing.md §3（純粋関数は正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  isEffectiveOn,
  pricingRuleStage,
  resolvePricingRule,
  type PricingQuery,
  type PricingRuleCandidate,
} from "./pricing.js";

const BASE: PricingRuleCandidate = {
  id: "rule_base",
  propertyId: null,
  roomTypeId: null,
  taskType: null,
  itemCode: "CLEAN_CHECKOUT",
  unitPrice: 3000,
  taxRate: 10,
  isReducedRate: false,
  validFrom: "2026-01-01",
  validTo: null,
  priority: 50,
};

function rule(overrides: Partial<PricingRuleCandidate>): PricingRuleCandidate {
  return { ...BASE, ...overrides };
}

const QUERY: PricingQuery = {
  itemCode: "CLEAN_CHECKOUT",
  propertyId: "prop_1",
  roomTypeId: "rt_single",
  taskType: "CHECKOUT",
  on: "2026-09-15",
};

describe("pricingRuleStage — §3.2 の 5 段", () => {
  it.each([
    ["施設 + 客室タイプ + 作業種別", { propertyId: "p", roomTypeId: "r", taskType: "CHECKOUT" }, 1],
    ["施設 + 作業種別", { propertyId: "p", roomTypeId: null, taskType: "CHECKOUT" }, 2],
    ["施設のみ", { propertyId: "p", roomTypeId: null, taskType: null }, 3],
    ["作業種別のみ", { propertyId: null, roomTypeId: null, taskType: "CHECKOUT" }, 4],
    ["取引先の既定", { propertyId: null, roomTypeId: null, taskType: null }, 5],
  ])("%s → 第 %i 段", (_label, shape, stage) => {
    expect(pricingRuleStage(shape)).toBe(stage);
  });

  it.each([
    ["施設 + 客室タイプ（作業種別なし）", { propertyId: "p", roomTypeId: "r", taskType: null }],
    ["客室タイプのみ", { propertyId: null, roomTypeId: "r", taskType: null }],
    ["客室タイプ + 作業種別", { propertyId: null, roomTypeId: "r", taskType: "CHECKOUT" }],
  ])("%s は梯子に載らない（null）", (_label, shape) => {
    expect(pricingRuleStage(shape)).toBeNull();
  });

  it("梯子に載らない形は、条件が完全に一致していても選ばれない", () => {
    const dead = rule({ id: "dead", propertyId: "prop_1", roomTypeId: "rt_single", unitPrice: 9999 });
    expect(pricingRuleStage(dead)).toBeNull();
    expect(resolvePricingRule([dead], QUERY)).toBeNull();
  });
});

describe("isEffectiveOn — 有効期間", () => {
  it.each([
    ["開始日の当日", "2026-01-01", null, "2026-01-01"],
    ["期間の途中", "2026-01-01", "2026-12-31", "2026-06-30"],
    ["終了日の当日", "2026-01-01", "2026-09-30", "2026-09-30"],
    ["終了日なし（無期限）", "2020-04-01", null, "2030-01-01"],
    ["開始日の翌日", "2026-01-01", "2026-01-31", "2026-01-02"],
  ])("%s は有効", (_label, validFrom, validTo, on) => {
    expect(isEffectiveOn({ validFrom, validTo }, on)).toBe(true);
  });

  it.each([
    ["開始日の前日", "2026-02-01", null, "2026-01-31"],
    ["終了日の翌日", "2026-01-01", "2026-09-30", "2026-10-01"],
    ["期間より前", "2026-01-01", "2026-12-31", "2025-12-31"],
    ["期間より後", "2024-01-01", "2024-12-31", "2026-01-01"],
    ["1 日だけの設定の前日", "2026-05-05", "2026-05-05", "2026-05-04"],
  ])("%s は無効", (_label, validFrom, validTo, on) => {
    expect(isEffectiveOn({ validFrom, validTo }, on)).toBe(false);
  });
});

describe("resolvePricingRule — 具体的な行が勝つ", () => {
  const ladder = [
    rule({ id: "s5", unitPrice: 1000 }),
    rule({ id: "s4", taskType: "CHECKOUT", unitPrice: 2000 }),
    rule({ id: "s3", propertyId: "prop_1", unitPrice: 3000 }),
    rule({ id: "s2", propertyId: "prop_1", taskType: "CHECKOUT", unitPrice: 4000 }),
    rule({
      id: "s1",
      propertyId: "prop_1",
      roomTypeId: "rt_single",
      taskType: "CHECKOUT",
      unitPrice: 5000,
    }),
  ];

  it.each([
    [5, ["s5"], 1000],
    [4, ["s5", "s4"], 2000],
    [3, ["s5", "s4", "s3"], 3000],
    [2, ["s5", "s4", "s3", "s2"], 4000],
    [1, ["s5", "s4", "s3", "s2", "s1"], 5000],
  ])("第 %i 段が最も具体的なら単価 %j → ¥%i", (stage, ids, unitPrice) => {
    const candidates = ladder.filter((r) => ids.includes(r.id));
    const resolved = resolvePricingRule(candidates, QUERY);
    expect(resolved?.stage).toBe(stage);
    expect(resolved?.rule.unitPrice).toBe(unitPrice);
  });

  it("並び順を変えても結果が変わらない", () => {
    const forward = resolvePricingRule(ladder, QUERY);
    const backward = resolvePricingRule([...ladder].reverse(), QUERY);
    expect(forward?.rule.id).toBe("s1");
    expect(backward?.rule.id).toBe("s1");
  });
});

describe("resolvePricingRule — 該当が無い", () => {
  it.each([
    ["候補が空", []],
    ["品目コードが違う", [rule({ itemCode: "CLEAN_STAYOVER" })]],
    ["施設が違う", [rule({ propertyId: "prop_other", taskType: "CHECKOUT" })]],
    ["客室タイプが違う", [rule({ propertyId: "prop_1", roomTypeId: "rt_twin", taskType: "CHECKOUT" })]],
    ["作業種別が違う", [rule({ taskType: "STAYOVER" })]],
    ["期間の外", [rule({ validFrom: "2027-01-01" })]],
  ])("%s なら null", (_label, candidates) => {
    expect(resolvePricingRule(candidates, QUERY)).toBeNull();
  });

  it("null は「請求しない」ではない。¥0 明細の扱いは buildInvoiceDraft の責務", () => {
    // この spec が守るのは「黙って落とさない」の入口だけ。
    // 実際の ¥0 明細は aggregate.spec.ts が検査する。
    expect(resolvePricingRule([], QUERY)).toBeNull();
  });
});

describe("resolvePricingRule — 同じ段で競合したとき", () => {
  it("priority の小さいほうを採る（§3.2）", () => {
    const candidates = [
      rule({ id: "a", taskType: "CHECKOUT", priority: 90, unitPrice: 9000 }),
      rule({ id: "b", taskType: "CHECKOUT", priority: 10, unitPrice: 1000 }),
      rule({ id: "c", taskType: "CHECKOUT", priority: 50, unitPrice: 5000 }),
    ];
    expect(resolvePricingRule(candidates, QUERY)?.rule.id).toBe("b");
  });

  it("priority が同じなら validFrom が新しいほうを採る（値上げは行の追加）", () => {
    const candidates = [
      rule({ id: "old", taskType: "CHECKOUT", validFrom: "2026-01-01", unitPrice: 3000 }),
      rule({ id: "new", taskType: "CHECKOUT", validFrom: "2026-09-01", unitPrice: 3300 }),
    ];
    expect(resolvePricingRule(candidates, QUERY)?.rule.unitPrice).toBe(3300);
  });

  it("priority も validFrom も同じなら id の小さいほうを採る（同じ入力に同じ結果）", () => {
    const candidates = [
      rule({ id: "zzz", taskType: "CHECKOUT", unitPrice: 8000 }),
      rule({ id: "aaa", taskType: "CHECKOUT", unitPrice: 2000 }),
    ];
    expect(resolvePricingRule(candidates, QUERY)?.rule.id).toBe("aaa");
    expect(resolvePricingRule([...candidates].reverse(), QUERY)?.rule.id).toBe("aaa");
  });

  it("段は priority より強い。第 1 段の priority 99 が第 5 段の priority 1 に勝つ", () => {
    const candidates = [
      rule({ id: "broad", priority: 1, unitPrice: 1000 }),
      rule({
        id: "narrow",
        propertyId: "prop_1",
        roomTypeId: "rt_single",
        taskType: "CHECKOUT",
        priority: 99,
        unitPrice: 5000,
      }),
    ];
    const resolved = resolvePricingRule(candidates, QUERY);
    expect(resolved?.rule.id).toBe("narrow");
    expect(resolved?.stage).toBe(1);
  });
});

describe("resolvePricingRule — 客室タイプを持たない作業", () => {
  const commonQuery: PricingQuery = {
    itemCode: "CLEAN_COMMON",
    propertyId: "prop_1",
    roomTypeId: null,
    taskType: "COMMON_AREA",
    on: "2026-09-15",
  };

  it("第 2 段（施設 + 作業種別）で引ける", () => {
    const candidates = [
      rule({
        id: "common",
        propertyId: "prop_1",
        taskType: "COMMON_AREA",
        itemCode: "CLEAN_COMMON",
        unitPrice: 1500,
      }),
    ];
    const resolved = resolvePricingRule(candidates, commonQuery);
    expect(resolved?.stage).toBe(2);
    expect(resolved?.rule.unitPrice).toBe(1500);
  });

  it("客室タイプを指定した第 1 段の行は当たらない", () => {
    const candidates = [
      rule({
        id: "typed",
        propertyId: "prop_1",
        roomTypeId: "rt_single",
        taskType: "COMMON_AREA",
        itemCode: "CLEAN_COMMON",
      }),
    ];
    expect(resolvePricingRule(candidates, commonQuery)).toBeNull();
  });
});
