/**
 * R013 — 深夜帯の施錠解除（PK-SPEC-P4 §3.9）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 1 回でも深夜帯なら立てる（R002 は 2 回以上）
 *   - **`MOBILE_KEY` は数えない**（§3.9 は `GUEST_KEY` だけを名指し）
 *   - `localHour` が無ければ立てない（時差を推測しない）
 */

import { describe, expect, it } from "vitest";

import { R013, R013_BASE_CONFIDENCE, lateNightGuestUnlocksOf } from "./R013.js";
import { occupancyFact, ruleContext, signalFact } from "./testContext.js";

/** 深夜帯の解錠。 */
function lateNight(overrides: Parameters<typeof signalFact>[0] = {}) {
  return signalFact({
    occurredAt: Date.parse("2026-09-10T02:30:00+09:00"),
    localHour: 2,
    ...overrides,
  });
}

/** 空室に深夜の解錠がある文脈。 */
function context(overrides: Parameters<typeof ruleContext>[0] = {}) {
  return ruleContext({
    occupancy: occupancyFact({ isOccupied: false, guestCount: 0, reservationRef: null }),
    signals: [lateNight()],
    ...overrides,
  });
}

describe("R013 — 正例（差異になる）", () => {
  it("空室に深夜帯の解錠が 1 回でもあれば差異", () => {
    const finding = R013.evaluate(context());
    expect(finding?.ruleCode).toBe("R013");
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("確信度は固定", () => {
    expect(R013.evaluate(context())?.confidence).toBe(R013_BASE_CONFIDENCE);
  });

  it("0 時ちょうども深夜帯", () => {
    expect(R013.evaluate(context({ signals: [lateNight({ localHour: 0 })] }))).not.toBeNull();
  });

  it("4 時台も深夜帯", () => {
    expect(R013.evaluate(context({ signals: [lateNight({ localHour: 4 })] }))).not.toBeNull();
  });

  it("複数回でも 1 件にまとまる", () => {
    const finding = R013.evaluate(context({ signals: [lateNight(), lateNight()] }));
    expect(finding?.matchedSignals).toEqual(["LATE_NIGHT_GUEST_UNLOCK"]);
  });

  it("解錠の記録を根拠に残す", () => {
    const finding = R013.evaluate(context());
    expect(Array.isArray(finding?.evidence["signals"])).toBe(true);
  });
});

describe("R013 — 負例（差異にしない）", () => {
  it("5 時は深夜帯に含まない", () => {
    expect(R013.evaluate(context({ signals: [lateNight({ localHour: 5 })] }))).toBeNull();
  });

  it("日中の解錠は差異にしない", () => {
    expect(R013.evaluate(context({ signals: [lateNight({ localHour: 14 })] }))).toBeNull();
  });

  it("**`MOBILE_KEY` は数えない**（§3.9 は `GUEST_KEY` だけ）", () => {
    expect(
      R013.evaluate(context({ signals: [lateNight({ actorType: "MOBILE_KEY" })] })),
    ).toBeNull();
  });

  it("**地域時刻が分からなければ差異にしない**（推測しない）", () => {
    expect(R013.evaluate(context({ signals: [lateNight({ localHour: null })] }))).toBeNull();
  });

  it("稼働している日は差異にしない", () => {
    expect(R013.evaluate(context({ occupancy: occupancyFact({ isOccupied: true }) }))).toBeNull();
  });

  it("入室記録があれば差異にしない", () => {
    expect(
      R013.evaluate(
        context({ accessLogs: [{ purpose: "INSPECTION", enteredAt: 0, exitedAt: null }] }),
      ),
    ).toBeNull();
  });

  it("解錠以外のシグナルは数えない", () => {
    expect(
      R013.evaluate(context({ signals: [lateNight({ signalType: "POWER_ON" })] })),
    ).toBeNull();
  });
});

describe("lateNightGuestUnlocksOf", () => {
  it("深夜帯の宿泊者鍵の解錠だけを返す", () => {
    const signals = [
      lateNight(),
      lateNight({ localHour: 12 }),
      lateNight({ actorType: "STAFF_KEY" }),
      lateNight({ signalType: "DOOR_OPEN" }),
    ];
    expect(lateNightGuestUnlocksOf(signals)).toHaveLength(1);
  });

  it("空なら空", () => {
    expect(lateNightGuestUnlocksOf([])).toEqual([]);
  });
});
