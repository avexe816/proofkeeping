/**
 * 自動配分に効くスタッフの属性（P8-04）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例）
 *
 * ── ここが守っているもの ────────────────────────────────
 *   1. **未入力を制約にしない**（入社日なし・スキル空 → 制約なし）
 *   2. 1 年目の境界（364 日目は 1 年目、365 日目は違う）
 *   3. 研修中の判定が `workStatus` だけを見る
 */

import type { StaffLedgerRow } from "@pk/db";
import { describe, expect, it } from "vitest";

import { buildStaffTraits } from "./traits.js";

const ORG = "a1b2c3";
const TODAY = "2026-08-20";

function ledgerRow(overrides: Partial<StaffLedgerRow> = {}): StaffLedgerRow {
  return {
    id: `${ORG}__sppf_01JBXQ3ZK8N4P2VYR60000`,
    membershipId: `${ORG}__mem_01JBXQ3ZK8N4P2VYR60000`,
    hiredOn: null,
    resignedOn: null,
    workStatus: "ACTIVE",
    languages: [],
    skills: [],
    note: null,
    ...overrides,
  };
}

describe("buildStaffTraits", () => {
  it("スキルが入っていれば渡す", () => {
    const traits = buildStaffTraits([ledgerRow({ skills: ["CHECKOUT", "DEEP"] })], TODAY);
    expect(traits[0]?.skills).toEqual(["CHECKOUT", "DEEP"]);
  });

  it("**スキルが空なら `undefined`**（「何もできない」と読まない）", () => {
    const traits = buildStaffTraits([ledgerRow({ skills: [] })], TODAY);
    expect(traits[0]?.skills).toBeUndefined();
  });

  it("入社 3 か月なら 1 年目", () => {
    const traits = buildStaffTraits([ledgerRow({ hiredOn: "2026-05-20" })], TODAY);
    expect(traits[0]?.isFirstYear).toBe(true);
  });

  it("**364 日目はまだ 1 年目**（境界）", () => {
    const traits = buildStaffTraits([ledgerRow({ hiredOn: "2025-08-21" })], TODAY);
    expect(traits[0]?.isFirstYear).toBe(true);
  });

  it("**365 日目（満 1 年）は 1 年目ではない**", () => {
    const traits = buildStaffTraits([ledgerRow({ hiredOn: "2025-08-20" })], TODAY);
    expect(traits[0]?.isFirstYear).toBe(false);
  });

  it("**入社日が無ければ 1 年目にしない**（未入力を制約にしない）", () => {
    const traits = buildStaffTraits([ledgerRow({ hiredOn: null })], TODAY);
    expect(traits[0]?.isFirstYear).toBe(false);
  });

  it("入社日が未来なら 1 年目にしない（負の在籍を作らない）", () => {
    const traits = buildStaffTraits([ledgerRow({ hiredOn: "2027-01-01" })], TODAY);
    expect(traits[0]?.isFirstYear).toBe(false);
  });

  it("研修中は `inTraining`", () => {
    const traits = buildStaffTraits([ledgerRow({ workStatus: "TRAINING" })], TODAY);
    expect(traits[0]?.inTraining).toBe(true);
  });

  it("休職中は研修中ではない", () => {
    const traits = buildStaffTraits([ledgerRow({ workStatus: "ON_LEAVE" })], TODAY);
    expect(traits[0]?.inTraining).toBe(false);
  });

  it("**評価・点数・速度の項目が無い**（security.md §5）", () => {
    const traits = buildStaffTraits([ledgerRow()], TODAY);
    const keys = Object.keys(traits[0] ?? {});
    for (const forbidden of ["score", "speed", "rank", "rating"]) {
      expect(keys.some((key) => key.toLowerCase().includes(forbidden)), forbidden).toBe(false);
    }
  });
});
