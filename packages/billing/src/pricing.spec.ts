/**
 * 料金の解決（PK-SPEC-P5 §3.2 / billing.md §8）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── いちばん大事なテスト ────────────────────────────────
 * **該当が無いとき `null` を返すこと。** 0 を返すと「無料と決めた」と
 * 「値段が決まっていない」が混ざり、決め忘れが請求書に 0 円として
 * 静かに載る（§3.2 MUST）。
 */

import { describe, expect, it } from "vitest";

import {
  PRICING_STAGES,
  isEffective,
  matchStage,
  resolvePricing,
  resolveUnitPrice,
  type PricingKey,
  type PricingRuleFact,
} from "./pricing.js";

const PROPERTY = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const OTHER_PROPERTY = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ZZZZZZ";
const ROOM_TYPE = "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const OTHER_ROOM_TYPE = "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ZZZZZZ";

function rule(overrides: Partial<PricingRuleFact> = {}): PricingRuleFact {
  return {
    id: "o7k2m9__prc_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
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
    ...overrides,
  };
}

function key(overrides: Partial<PricingKey> = {}): PricingKey {
  return {
    propertyId: PROPERTY,
    roomTypeId: ROOM_TYPE,
    taskType: "CHECKOUT",
    itemCode: "CLEAN_CHECKOUT",
    serviceDate: "2026-09-09",
    ...overrides,
  };
}

describe("resolvePricing — 5 段階の優先順位（§3.2）", () => {
  it("① 施設 + 客室タイプ + 作業種別 がいちばん強い", () => {
    const resolved = resolvePricing(
      [
        rule({ id: "default", unitPrice: 1000 }),
        rule({ id: "task", taskType: "CHECKOUT", unitPrice: 2000 }),
        rule({ id: "property", propertyId: PROPERTY, unitPrice: 3000 }),
        rule({ id: "propTask", propertyId: PROPERTY, taskType: "CHECKOUT", unitPrice: 4000 }),
        rule({
          id: "full",
          propertyId: PROPERTY,
          roomTypeId: ROOM_TYPE,
          taskType: "CHECKOUT",
          unitPrice: 5000,
        }),
      ],
      key(),
    );
    expect(resolved?.stage).toBe("PROPERTY_ROOM_TYPE_TASK");
    expect(resolved?.rule.unitPrice).toBe(5000);
  });

  it("② 施設 + 作業種別 が次", () => {
    const resolved = resolvePricing(
      [
        rule({ id: "default", unitPrice: 1000 }),
        rule({ id: "propTask", propertyId: PROPERTY, taskType: "CHECKOUT", unitPrice: 4000 }),
      ],
      key(),
    );
    expect(resolved?.stage).toBe("PROPERTY_TASK");
  });

  it("③ 施設だけ が次", () => {
    const resolved = resolvePricing(
      [rule({ id: "default" }), rule({ id: "property", propertyId: PROPERTY, unitPrice: 3000 })],
      key(),
    );
    expect(resolved?.stage).toBe("PROPERTY");
  });

  it("④ 作業種別だけ が次", () => {
    const resolved = resolvePricing(
      [rule({ id: "default" }), rule({ id: "task", taskType: "CHECKOUT", unitPrice: 2000 })],
      key(),
    );
    expect(resolved?.stage).toBe("TASK");
  });

  it("⑤ 取引先の既定が最後", () => {
    const resolved = resolvePricing([rule({ id: "default", unitPrice: 1000 })], key());
    expect(resolved?.stage).toBe("COUNTERPARTY_DEFAULT");
    expect(resolved?.rule.unitPrice).toBe(1000);
  });

  it("**同じ段なら `priority` が小さいほうが勝つ**（§3.2）", () => {
    const resolved = resolvePricing(
      [
        rule({ id: "high", propertyId: PROPERTY, priority: 90, unitPrice: 9000 }),
        rule({ id: "low", propertyId: PROPERTY, priority: 10, unitPrice: 1000 }),
      ],
      key(),
    );
    expect(resolved?.rule.unitPrice).toBe(1000);
  });

  it("すべて同点なら新しく始まった規則を採る", () => {
    const resolved = resolvePricing(
      [
        rule({ id: "old", propertyId: PROPERTY, validFrom: "2026-01-01", unitPrice: 1000 }),
        rule({ id: "new", propertyId: PROPERTY, validFrom: "2026-06-01", unitPrice: 2000 }),
      ],
      key(),
    );
    expect(resolved?.rule.unitPrice).toBe(2000);
  });

  it("並び順に依存しない（同じ入力なら同じ結果）", () => {
    const rules = [
      rule({ id: "a", propertyId: PROPERTY }),
      rule({ id: "b", propertyId: PROPERTY }),
    ];
    expect(resolvePricing(rules, key())?.rule.id).toBe(
      resolvePricing([...rules].reverse(), key())?.rule.id,
    );
  });
});

describe("resolvePricing — 当たらない（負例）", () => {
  it("**該当が無ければ `null`**（0 を返さない / §3.2 MUST）", () => {
    expect(resolvePricing([], key())).toBeNull();
    expect(resolveUnitPrice([], key())).toBeNull();
  });

  it("品目が違えば当たらない", () => {
    expect(resolvePricing([rule({ itemCode: "CLEAN_STAYOVER" })], key())).toBeNull();
  });

  it("別の施設に限定された規則は当たらない", () => {
    expect(resolvePricing([rule({ propertyId: OTHER_PROPERTY })], key())).toBeNull();
  });

  it("別の客室タイプに限定された規則は当たらない", () => {
    expect(resolvePricing([rule({ roomTypeId: OTHER_ROOM_TYPE })], key())).toBeNull();
  });

  it("別の作業種別に限定された規則は当たらない", () => {
    expect(resolvePricing([rule({ taskType: "STAY" })], key())).toBeNull();
  });

  it("有効期間の前は当たらない", () => {
    expect(resolvePricing([rule({ validFrom: "2026-10-01" })], key())).toBeNull();
  });

  it("有効期間の後は当たらない", () => {
    expect(resolvePricing([rule({ validTo: "2026-08-31" })], key())).toBeNull();
  });

  it("**0 円と「未設定」を混ぜない**", () => {
    // 0 円の規則があれば 0 が返る（無料と決めた）。
    expect(resolveUnitPrice([rule({ unitPrice: 0 })], key())).toBe(0);
    // 規則が無ければ null（値段が決まっていない）。
    expect(resolveUnitPrice([], key())).toBeNull();
  });
});

describe("isEffective — 有効期間（§2.2）", () => {
  it("開始日ちょうどは有効", () => {
    expect(isEffective(rule({ validFrom: "2026-09-09" }), "2026-09-09")).toBe(true);
  });

  it("終了日ちょうども有効（両端を含む）", () => {
    expect(isEffective(rule({ validTo: "2026-09-09" }), "2026-09-09")).toBe(true);
  });

  it("終了日が無ければ以後ずっと有効", () => {
    expect(isEffective(rule({ validTo: null }), "2099-12-31")).toBe(true);
  });

  it("開始前は無効", () => {
    expect(isEffective(rule({ validFrom: "2026-09-10" }), "2026-09-09")).toBe(false);
  });

  it("終了後は無効", () => {
    expect(isEffective(rule({ validTo: "2026-09-08" }), "2026-09-09")).toBe(false);
  });
});

describe("matchStage — 段の判定", () => {
  it("客室タイプだけの規則は取引先の既定に落ちる（§3.2 に段が無い）", () => {
    expect(matchStage(rule({ roomTypeId: ROOM_TYPE }), key())).toBe("COUNTERPARTY_DEFAULT");
  });

  it("鍵の客室タイプが `null` でも、規則が客室タイプを指定していれば外れる", () => {
    expect(matchStage(rule({ roomTypeId: ROOM_TYPE }), key({ roomTypeId: null }))).toBeNull();
  });

  it("5 段階が仕様の順に並んでいる", () => {
    expect(PRICING_STAGES).toEqual([
      "PROPERTY_ROOM_TYPE_TASK",
      "PROPERTY_TASK",
      "PROPERTY",
      "TASK",
      "COUNTERPARTY_DEFAULT",
    ]);
  });
});
