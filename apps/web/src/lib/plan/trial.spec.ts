/**
 * トライアルの期間・上限・終了後の扱い（P7-03 / PK-SPEC-P7 §2.5）。
 *
 * **正例と負例を最低 5 件ずつ**（.claude/rules/testing.md §3）。
 */

import { describe, expect, it } from "vitest";

import {
  TRIAL_DAYS,
  TRIAL_MAX_PROPERTIES,
  TRIAL_MAX_ROOMS,
  TRIAL_RETENTION_DAYS,
  canAddRooms,
  isReadOnly,
  limitsOf,
  remainingProperties,
  remainingRooms,
  retentionEndsAt,
  trialEndsAtFrom,
  trialPhaseOf,
} from "./trial.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-08-01T00:00:00.000Z");
const ENDS_AT = new Date(START.getTime() + TRIAL_DAYS * DAY_MS);

describe("§2.5 の値", () => {
  it("30 日 / 施設 3 / 客室 150 / 保持 90 日", () => {
    expect(TRIAL_DAYS).toBe(30);
    expect(TRIAL_MAX_PROPERTIES).toBe(3);
    expect(TRIAL_MAX_ROOMS).toBe(150);
    expect(TRIAL_RETENTION_DAYS).toBe(90);
  });

  it("開始から 30 日後が終了", () => {
    expect(trialEndsAtFrom(START).toISOString()).toBe(ENDS_AT.toISOString());
  });

  it("終了から 90 日後が保持の期限", () => {
    expect(retentionEndsAt(ENDS_AT).getTime()).toBe(ENDS_AT.getTime() + 90 * DAY_MS);
  });
});

describe("trialPhaseOf", () => {
  it("トライアルでなければ `NOT_TRIAL`", () => {
    for (const status of ["ACTIVE", "PAST_DUE", "CANCELED", null, undefined, ""]) {
      expect(trialPhaseOf({ status, trialEndsAt: ENDS_AT }, START)).toBe("NOT_TRIAL");
    }
  });

  it("期限前は `ACTIVE`", () => {
    for (const offset of [0, 1, DAY_MS, 29 * DAY_MS, 30 * DAY_MS - 1]) {
      const now = new Date(START.getTime() + offset);
      expect(trialPhaseOf({ status: "TRIAL", trialEndsAt: ENDS_AT }, now)).toBe("ACTIVE");
    }
  });

  it("**期限が無いトライアルは `ACTIVE`**（設定漏れで止めない）", () => {
    expect(trialPhaseOf({ status: "TRIAL", trialEndsAt: null }, START)).toBe("ACTIVE");
    expect(trialPhaseOf({ status: "TRIAL", trialEndsAt: undefined }, START)).toBe("ACTIVE");
  });

  it("期限ちょうど以降・保持期限までは `EXPIRED`", () => {
    for (const offset of [0, 1, DAY_MS, 89 * DAY_MS, 90 * DAY_MS - 1]) {
      const now = new Date(ENDS_AT.getTime() + offset);
      expect(trialPhaseOf({ status: "TRIAL", trialEndsAt: ENDS_AT }, now)).toBe("EXPIRED");
    }
  });

  it("保持期限を過ぎたら `RETENTION_ENDED`", () => {
    for (const offset of [90 * DAY_MS, 91 * DAY_MS, 365 * DAY_MS]) {
      const now = new Date(ENDS_AT.getTime() + offset);
      expect(trialPhaseOf({ status: "TRIAL", trialEndsAt: ENDS_AT }, now)).toBe("RETENTION_ENDED");
    }
  });
});

describe("isReadOnly", () => {
  it("**終了後は読み取り専用**（§2.5）", () => {
    expect(isReadOnly("EXPIRED")).toBe(true);
    expect(isReadOnly("RETENTION_ENDED")).toBe(true);
  });

  it("トライアル中と非トライアルは書ける", () => {
    expect(isReadOnly("ACTIVE")).toBe(false);
    expect(isReadOnly("NOT_TRIAL")).toBe(false);
  });
});

describe("上限", () => {
  it("**トライアル中だけ掛かる**", () => {
    expect(limitsOf("ACTIVE")).toEqual({ properties: 3, rooms: 150 });
    for (const phase of ["NOT_TRIAL", "EXPIRED", "RETENTION_ENDED"] as const) {
      expect(limitsOf(phase)).toEqual({ properties: null, rooms: null });
    }
  });

  it("残り数を返す", () => {
    expect(remainingRooms("ACTIVE", 0)).toBe(150);
    expect(remainingRooms("ACTIVE", 149)).toBe(1);
    expect(remainingRooms("ACTIVE", 150)).toBe(0);
    expect(remainingProperties("ACTIVE", 1)).toBe(2);
    expect(remainingRooms("NOT_TRIAL", 9999)).toBeNull();
  });

  it("**既に超えていても負の数にしない**", () => {
    expect(remainingRooms("ACTIVE", 200)).toBe(0);
    expect(remainingProperties("ACTIVE", 10)).toBe(0);
  });

  it("上限までは足せる", () => {
    expect(canAddRooms("ACTIVE", 0, 150)).toBe(true);
    expect(canAddRooms("ACTIVE", 100, 50)).toBe(true);
    expect(canAddRooms("ACTIVE", 149, 1)).toBe(true);
    expect(canAddRooms("ACTIVE", 0, 0)).toBe(true);
    expect(canAddRooms("NOT_TRIAL", 10_000, 10_000)).toBe(true);
  });

  it("**超える取込はまとめて拒む**（先頭だけ入れない）", () => {
    expect(canAddRooms("ACTIVE", 0, 151)).toBe(false);
    expect(canAddRooms("ACTIVE", 100, 51)).toBe(false);
    expect(canAddRooms("ACTIVE", 150, 1)).toBe(false);
    expect(canAddRooms("ACTIVE", 200, 1)).toBe(false);
    expect(canAddRooms("ACTIVE", 149, 2)).toBe(false);
  });
});
