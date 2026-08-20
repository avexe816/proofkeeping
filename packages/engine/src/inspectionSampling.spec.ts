import { describe, expect, it } from "vitest";

import {
  decideInspection,
  isNewStaff,
  isNewStaffByTraining,
  policyFromLegacyFlag,
  type InspectionDecisionInput,
  type InspectionPolicyInput,
  type MandatoryInspectionSignals,
} from "./inspectionSampling.js";

/**
 * 検査の要否（P2-02 / PK-SPEC-P2 §2.1〜§2.3）。
 *
 * testing.md §3: 純粋関数のルールには正例と負例を最低 5 件ずつ。
 */

const SAMPLE_POLICY: InspectionPolicyInput = {
  mode: "SAMPLE",
  sampleRate: 30,
  minDailySample: 0,
  alwaysInspectCheckin: true,
  alwaysInspectRework: true,
};

const NO_SIGNALS: MandatoryInspectionSignals = {
  hasCheckin: false,
  hadRework: false,
  isNewStaff: false,
  hasReport: false,
  isPriorityRoom: false,
};

function decide(overrides: Partial<InspectionDecisionInput> = {}) {
  return decideInspection({
    policy: SAMPLE_POLICY,
    signals: NO_SIGNALS,
    selectedToday: 99,
    draw: 0.99,
    ...overrides,
  });
}

describe("3 モード", () => {
  it("ALL は必ず検査対象", () => {
    expect(decide({ policy: { ...SAMPLE_POLICY, mode: "ALL" } })).toEqual({
      required: true,
      reason: "POLICY_ALL",
    });
  });

  it("NONE は必ず省略、理由は POLICY_NONE", () => {
    expect(decide({ policy: { ...SAMPLE_POLICY, mode: "NONE" } })).toEqual({
      required: false,
      skipReason: "POLICY_NONE",
    });
  });

  it("NONE は必須条件がすべて立っていても検査しない", () => {
    // 検査する人がいない施設で AWAITING_INSPECTION を作らない（§2.3）。
    expect(
      decide({
        policy: { ...SAMPLE_POLICY, mode: "NONE" },
        signals: {
          hasCheckin: true,
          hadRework: true,
          isNewStaff: true,
          hasReport: true,
          isPriorityRoom: true,
        },
      }),
    ).toEqual({ required: false, skipReason: "POLICY_NONE" });
  });

  it("SAMPLE の非抽出は NOT_SAMPLED", () => {
    expect(decide()).toEqual({ required: false, skipReason: "NOT_SAMPLED" });
  });

  it("ALL は抽選値に関係しない", () => {
    expect(decide({ policy: { ...SAMPLE_POLICY, mode: "ALL" }, draw: 0.999 })).toEqual({
      required: true,
      reason: "POLICY_ALL",
    });
  });
});

describe("必ず検査対象になる条件（§2.2）", () => {
  it.each([
    ["当日チェックイン", { hasCheckin: true }, "CHECKIN"],
    ["前回差戻し", { hadRework: true }, "PREVIOUS_REWORK"],
    ["新人スタッフ", { isNewStaff: true }, "NEW_STAFF"],
    ["不具合・忘れ物の報告", { hasReport: true }, "REPORT_FILED"],
    ["重点客室", { isPriorityRoom: true }, "PRIORITY_ROOM"],
  ] as const)("%s は抽出率 0 でも選ばれる", (_label, signal, reason) => {
    expect(
      decide({
        policy: { ...SAMPLE_POLICY, sampleRate: 0 },
        signals: { ...NO_SIGNALS, ...signal },
        draw: 0.999,
      }),
    ).toEqual({ required: true, reason });
  });

  it("alwaysInspectCheckin が false ならチェックインは強制しない", () => {
    expect(
      decide({
        policy: { ...SAMPLE_POLICY, alwaysInspectCheckin: false, sampleRate: 0 },
        signals: { ...NO_SIGNALS, hasCheckin: true },
      }),
    ).toEqual({ required: false, skipReason: "NOT_SAMPLED" });
  });

  it("alwaysInspectRework が false でも新人は強制する", () => {
    // 新人・報告・重点客室には施設側の切り替えが無い（§2.1 に列が無い）。
    expect(
      decide({
        policy: { ...SAMPLE_POLICY, alwaysInspectRework: false, sampleRate: 0 },
        signals: { ...NO_SIGNALS, hadRework: true, isNewStaff: true },
      }),
    ).toEqual({ required: true, reason: "NEW_STAFF" });
  });

  it("条件が重なったら先に判定したものが理由になる", () => {
    expect(
      decide({ signals: { ...NO_SIGNALS, hasCheckin: true, hadRework: true } }),
    ).toEqual({ required: true, reason: "CHECKIN" });
  });
});

describe("抽出（§2.2 の残り）", () => {
  it("最低件数に達するまでは必ず選ぶ", () => {
    expect(
      decide({ policy: { ...SAMPLE_POLICY, minDailySample: 3 }, selectedToday: 2, draw: 0.999 }),
    ).toEqual({ required: true, reason: "MIN_DAILY_SAMPLE" });
  });

  it("最低件数に達したら抽選へ進む", () => {
    expect(
      decide({ policy: { ...SAMPLE_POLICY, minDailySample: 3 }, selectedToday: 3, draw: 0.999 }),
    ).toEqual({ required: false, skipReason: "NOT_SAMPLED" });
  });

  it("抽出率 30% の境界: 0.299 は当たり、0.30 は外れ", () => {
    expect(decide({ draw: 0.299 })).toEqual({ required: true, reason: "SAMPLED" });
    expect(decide({ draw: 0.3 })).toEqual({ required: false, skipReason: "NOT_SAMPLED" });
  });

  it("抽出率 0% は抽選で当たらない", () => {
    expect(decide({ policy: { ...SAMPLE_POLICY, sampleRate: 0 }, draw: 0 })).toEqual({
      required: false,
      skipReason: "NOT_SAMPLED",
    });
  });

  it("抽出率 100% は必ず当たる", () => {
    expect(decide({ policy: { ...SAMPLE_POLICY, sampleRate: 100 }, draw: 0.999 })).toEqual({
      required: true,
      reason: "SAMPLED",
    });
  });

  it("範囲外の抽出率は 0〜100 に丸める", () => {
    expect(decide({ policy: { ...SAMPLE_POLICY, sampleRate: 500 }, draw: 0.99 })).toEqual({
      required: true,
      reason: "SAMPLED",
    });
    expect(decide({ policy: { ...SAMPLE_POLICY, sampleRate: -10 }, draw: 0 })).toEqual({
      required: false,
      skipReason: "NOT_SAMPLED",
    });
  });

  it.each([Number.NaN, -0.5, 1, 2])("壊れた抽選値 %s は検査する側へ倒す", (draw) => {
    expect(decide({ draw })).toEqual({ required: true, reason: "SAMPLED" });
  });
});

describe("policyFromLegacyFlag", () => {
  it("inspectionRequired = true は ALL", () => {
    expect(policyFromLegacyFlag(true).mode).toBe("ALL");
  });

  it("inspectionRequired = false は NONE", () => {
    // **`ALL` の既定で埋めない。** P1 の運用では false の施設が普通にある。
    expect(policyFromLegacyFlag(false).mode).toBe("NONE");
  });

  it("最低抽出件数を持ち込まない", () => {
    // SAMPLE でないので効かないが、0 にしておかないと将来 mode だけを
    // 差し替えたときに「設定した覚えのない最低件数」が効き始める。
    expect(policyFromLegacyFlag(true).minDailySample).toBe(0);
  });
});

describe("isNewStaff", () => {
  const NOW = Date.parse("2026-09-10T00:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;

  it("開始 29 日前は新人", () => {
    expect(isNewStaff(NOW - 29 * day, NOW)).toBe(true);
  });

  it("開始ちょうど 30 日前は新人ではない", () => {
    expect(isNewStaff(NOW - 30 * day, NOW)).toBe(false);
  });

  it("開始 90 日前は新人ではない", () => {
    expect(isNewStaff(NOW - 90 * day, NOW)).toBe(false);
  });

  it("開始時刻が分からなければ false", () => {
    // 分からないことを「新人」に倒すと、membership を引けない障害時に
    // 全タスクが検査対象になり検査待ちが詰まる。
    expect(isNewStaff(null, NOW)).toBe(false);
    expect(isNewStaff(Number.NaN, NOW)).toBe(false);
  });

  it("未来日付は新しい側として扱う", () => {
    expect(isNewStaff(NOW + day, NOW)).toBe(true);
  });
});

describe("isNewStaffByTraining — P8-10 / §1.7", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 7, 20);

  // ── 正例 ──────────────────────────────────────────────

  it("未修了なら新人", () => {
    expect(
      isNewStaffByTraining({ activePrograms: 6, completed: 4, lastCompletedOnMs: null, nowMs: NOW }),
    ).toBe(true);
  });

  it("修了から 29 日なら新人（継続 30 日）", () => {
    expect(
      isNewStaffByTraining({
        activePrograms: 6,
        completed: 6,
        lastCompletedOnMs: NOW - 29 * DAY,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("修了扱いなのに日付が無ければ新人（新しい側へ倒す）", () => {
    expect(
      isNewStaffByTraining({ activePrograms: 6, completed: 6, lastCompletedOnMs: null, nowMs: NOW }),
    ).toBe(true);
  });

  it("修了日が未来なら新人（登録の誤りでも新しい側へ）", () => {
    expect(
      isNewStaffByTraining({
        activePrograms: 6,
        completed: 6,
        lastCompletedOnMs: NOW + DAY,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("完了数が総数を超えていても（無効化の残骸）修了扱いで日数を見る", () => {
    expect(
      isNewStaffByTraining({
        activePrograms: 4,
        completed: 6,
        lastCompletedOnMs: NOW - 60 * DAY,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  // ── 負例 ──────────────────────────────────────────────

  it("**プログラムの無い組織では効かない**（全員が新人になって検査が詰まる）", () => {
    expect(
      isNewStaffByTraining({ activePrograms: 0, completed: 0, lastCompletedOnMs: null, nowMs: NOW }),
    ).toBe(false);
  });

  it("修了から 30 日ちょうどで新人ではなくなる", () => {
    expect(
      isNewStaffByTraining({
        activePrograms: 6,
        completed: 6,
        lastCompletedOnMs: NOW - 30 * DAY,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("修了から 1 年なら新人ではない", () => {
    expect(
      isNewStaffByTraining({
        activePrograms: 6,
        completed: 6,
        lastCompletedOnMs: NOW - 365 * DAY,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});
