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

import { UNKNOWN_ACTOR_CONFIDENCE_PENALTY } from "../staffKey.js";

import { R013, R013_BASE_CONFIDENCE, lateNightGuestUnlocksOf } from "./R013.js";
import { occupancyFact, ruleContext, signalFact, taskFact } from "./testContext.js";

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

/**
 * P6-08 — スタッフキー除外と `actorType` 不明（PK-SPEC-P6 §4.3・§4.4）。
 *
 * 窓の境界そのものは `staffKey.spec.ts` が見る。ここは
 * **R013 の結論がどう変わるか**だけを見る。
 */
describe("R013 — 清掃時刻による除外と種別不明", () => {
  /** 深夜 2:30 の解錠を挟むように清掃したことにする（現実には起きないが窓の検証）。 */
  const startedAt = Date.parse("2026-09-10T02:25:00+09:00");

  it("清掃の前後 10 分の解錠は数えない（§4.4）", () => {
    expect(
      R013.evaluate(
        context({ task: taskFact({ startedAt, completedAt: null }) }),
      ),
    ).toBeNull();
  });

  it("清掃の窓を外れていれば数える", () => {
    const finding = R013.evaluate(
      context({
        task: taskFact({
          startedAt: Date.parse("2026-09-09T10:00:00+09:00"),
          completedAt: Date.parse("2026-09-09T10:40:00+09:00"),
        }),
      }),
    );
    expect(finding?.ruleCode).toBe("R013");
  });

  it("鍵の種別が無い深夜の解錠も数える（§4.3）", () => {
    const finding = R013.evaluate(context({ signals: [lateNight({ actorType: null })] }));
    expect(finding?.ruleCode).toBe("R013");
  });

  it("不明が混ざれば確信度が 25 下がる", () => {
    const finding = R013.evaluate(context({ signals: [lateNight({ actorType: "UNKNOWN" })] }));
    expect(finding?.confidence).toBe(R013_BASE_CONFIDENCE + UNKNOWN_ACTOR_CONFIDENCE_PENALTY);
  });

  it("種別が取れていれば減点しない", () => {
    expect(R013.evaluate(context())?.confidence).toBe(R013_BASE_CONFIDENCE);
  });

  it("不明であることを根拠に残し、書き換えない（§4.3 MUST）", () => {
    const finding = R013.evaluate(context({ signals: [lateNight({ actorType: null })] }));
    expect(finding?.evidence["actorTypeUnknown"]).toBe(true);
    expect(finding?.evidence["signals"]).toMatchObject([{ actorType: null }]);
  });

  it("スタッフの鍵は深夜でも数えない", () => {
    expect(
      R013.evaluate(context({ signals: [lateNight({ actorType: "MASTER_KEY" })] })),
    ).toBeNull();
  });
});
