/**
 * ルール設定の解決と指紋（P4-05 / PK-SPEC-P4 §2.4・§2.7）。
 *
 * ルール: .claude/rules/testing.md §3
 */

import { describe, expect, it } from "vitest";

import { resolveRuleSettings, rulesetHashOf, type RuleConfigRow } from "./ruleset.js";

const PROPERTY = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6";
const OTHER_PROPERTY = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR7";

function row(overrides: Partial<RuleConfigRow> = {}): RuleConfigRow {
  return {
    propertyId: null,
    ruleCode: "R001",
    isEnabled: true,
    severityOverride: null,
    thresholds: {},
    ...overrides,
  };
}

describe("resolveRuleSettings — 施設の設定が組織の既定に勝つ（§2.7）", () => {
  it("組織の既定だけならそれを使う", () => {
    const settings = resolveRuleSettings([row({ isEnabled: false })], PROPERTY);
    expect(settings["R001"]?.isEnabled).toBe(false);
  });

  it("施設の行があればそちらが勝つ", () => {
    const settings = resolveRuleSettings(
      [row({ isEnabled: false }), row({ propertyId: PROPERTY, isEnabled: true })],
      PROPERTY,
    );
    expect(settings["R001"]?.isEnabled).toBe(true);
  });

  it("並びが逆でも結果が変わらない（DB の返す順に依らない）", () => {
    const rows = [row({ propertyId: PROPERTY, isEnabled: true }), row({ isEnabled: false })];
    expect(resolveRuleSettings(rows, PROPERTY)).toEqual(
      resolveRuleSettings([...rows].reverse(), PROPERTY),
    );
  });

  it("別の施設の行は効かない", () => {
    const settings = resolveRuleSettings(
      [row({ propertyId: OTHER_PROPERTY, isEnabled: false })],
      PROPERTY,
    );
    expect(settings["R001"]).toBeUndefined();
  });

  it("設定の無いルールは鍵ごと現れない（`evaluate()` の既定が効く）", () => {
    expect(resolveRuleSettings([], PROPERTY)).toEqual({});
  });

  it("重要度の上書きと閾値をそのまま渡す", () => {
    const settings = resolveRuleSettings(
      [row({ severityOverride: "LOW", thresholds: { minSignals: 2 } })],
      PROPERTY,
    );
    expect(settings["R001"]).toEqual({
      isEnabled: true,
      severityOverride: "LOW",
      thresholds: { minSignals: 2 },
    });
  });
});

describe("rulesetHashOf — 設定の指紋（§2.4）", () => {
  it("同じ設定からは同じ値", () => {
    const settings = resolveRuleSettings([row()], PROPERTY);
    expect(rulesetHashOf(settings)).toBe(rulesetHashOf(settings));
  });

  it("ルールの並びが違っても同じ値", () => {
    const first = { R001: settingOf(true), R006: settingOf(false) };
    const second = { R006: settingOf(false), R001: settingOf(true) };
    expect(rulesetHashOf(first)).toBe(rulesetHashOf(second));
  });

  it("有効・無効が変われば値が変わる", () => {
    expect(rulesetHashOf({ R001: settingOf(true) })).not.toBe(
      rulesetHashOf({ R001: settingOf(false) }),
    );
  });

  it("閾値が変われば値が変わる", () => {
    expect(
      rulesetHashOf({ R001: { ...settingOf(true), thresholds: { minSignals: 1 } } }),
    ).not.toBe(rulesetHashOf({ R001: { ...settingOf(true), thresholds: { minSignals: 2 } } }));
  });

  it("閾値の鍵の並びが違っても同じ値", () => {
    const first = { R001: { ...settingOf(true), thresholds: { a: 1, b: 2 } } };
    const second = { R001: { ...settingOf(true), thresholds: { b: 2, a: 1 } } };
    expect(rulesetHashOf(first)).toBe(rulesetHashOf(second));
  });

  it("設定が空でも 8 桁の 16 進を返す", () => {
    expect(rulesetHashOf({})).toMatch(/^[0-9a-f]{8}$/);
  });
});

function settingOf(isEnabled: boolean) {
  return { isEnabled, severityOverride: null, thresholds: {} };
}
