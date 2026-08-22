/**
 * W-18 検査ポリシー設定の値づくり（`policySettings.ts`）。
 *
 * ここが守るのは 2 つ。
 *   ① 画面に入力欄の無い 5 項目が、保存のたびに既定値へ戻らないこと
 *   ② 壊れた入力で「検査対象が 0 件になる値」を保存しないこと
 */

import { legacyPolicyValues, type InspectionPolicyInput } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  MAX_MIN_DAILY_SAMPLE,
  parseInspectionPolicyForm,
  resolveEffectivePolicy,
} from "./policySettings.js";

/** 現在値。**5 項目は既定と違う値**にしてある（持ち越しを見るため）。 */
const CURRENT: InspectionPolicyInput = {
  mode: "SAMPLE",
  sampleRate: 30,
  minDailySample: 3,
  alwaysInspectCheckin: false,
  alwaysInspectRework: false,
  selfInspectionAllowed: true,
  autoAssignInspector: false,
  inspectionSlaMinutes: 45,
};

function formOf(values: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => values[name] ?? null };
}

describe("resolveEffectivePolicy", () => {
  it("行があればその値を返し、設定済みとする", () => {
    const result = resolveEffectivePolicy(CURRENT, false);
    expect(result.configured).toBe(true);
    expect(result.values).toEqual(CURRENT);
  });

  it("行が無ければ P1 の真偽値から導き、未設定とする（true → ALL）", () => {
    const result = resolveEffectivePolicy(undefined, true);
    expect(result.configured).toBe(false);
    expect(result.values).toEqual(legacyPolicyValues(true));
    expect(result.values.mode).toBe("ALL");
  });

  it("行が無く P1 が false なら NONE（既定の ALL で埋めない）", () => {
    // 埋めると全タスクが検査待ちで滞留する（OPEN_QUESTIONS #044）。
    const result = resolveEffectivePolicy(undefined, false);
    expect(result.values.mode).toBe("NONE");
  });

  it("行の余分な列を持ち越さない", () => {
    const row = { ...CURRENT, id: "o7k2m9__ipol_01", organizationId: "org_a" };
    expect(Object.keys(resolveEffectivePolicy(row, false).values).sort()).toEqual(
      Object.keys(CURRENT).sort(),
    );
  });
});

describe("parseInspectionPolicyForm", () => {
  it("方式・抽出率・最低件数を読む", () => {
    const next = parseInspectionPolicyForm(
      formOf({ mode: "ALL", sampleRate: "80", minDailySample: "5" }),
      CURRENT,
    );
    expect(next.mode).toBe("ALL");
    expect(next.sampleRate).toBe(80);
    expect(next.minDailySample).toBe(5);
  });

  it("**入力欄の無い 5 項目を現在値のまま持ち越す**", () => {
    const next = parseInspectionPolicyForm(formOf({ mode: "NONE" }), CURRENT);
    expect(next.alwaysInspectCheckin).toBe(CURRENT.alwaysInspectCheckin);
    expect(next.alwaysInspectRework).toBe(CURRENT.alwaysInspectRework);
    expect(next.selfInspectionAllowed).toBe(CURRENT.selfInspectionAllowed);
    expect(next.autoAssignInspector).toBe(CURRENT.autoAssignInspector);
    expect(next.inspectionSlaMinutes).toBe(CURRENT.inspectionSlaMinutes);
  });

  it("語彙に無い方式は現在値のまま", () => {
    expect(parseInspectionPolicyForm(formOf({ mode: "PARTIAL" }), CURRENT).mode).toBe("SAMPLE");
  });

  it("方式が入っていなければ現在値のまま", () => {
    expect(parseInspectionPolicyForm(formOf({}), CURRENT).mode).toBe("SAMPLE");
  });

  it.each([
    ["非数", "abc"],
    ["数字の後ろに文字", "12abc"],
    ["負の値", "-1"],
    ["範囲外", "101"],
    ["空文字", ""],
  ])("抽出率が %s なら現在値のまま（0 を保存しない）", (_label, value) => {
    expect(parseInspectionPolicyForm(formOf({ sampleRate: value }), CURRENT).sampleRate).toBe(30);
  });

  it.each([
    ["非数", "abc"],
    ["負の値", "-3"],
    ["上限超過", String(MAX_MIN_DAILY_SAMPLE + 1)],
    ["小数", "1.5"],
    ["空白のみ", "   "],
  ])("最低件数が %s なら現在値のまま", (_label, value) => {
    expect(
      parseInspectionPolicyForm(formOf({ minDailySample: value }), CURRENT).minDailySample,
    ).toBe(3);
  });

  it("0 は正しい入力として通す（抽出率 0% + 最低件数で運用できる）", () => {
    const next = parseInspectionPolicyForm(
      formOf({ sampleRate: "0", minDailySample: "0" }),
      CURRENT,
    );
    expect(next.sampleRate).toBe(0);
    expect(next.minDailySample).toBe(0);
  });

  it("上限ちょうどは通す", () => {
    expect(
      parseInspectionPolicyForm(
        formOf({ sampleRate: "100", minDailySample: String(MAX_MIN_DAILY_SAMPLE) }),
        CURRENT,
      ),
    ).toMatchObject({ sampleRate: 100, minDailySample: MAX_MIN_DAILY_SAMPLE });
  });
});
