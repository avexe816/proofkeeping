/**
 * R002 — 施錠解除と稼働記録の不一致（PK-SPEC-P4 §3.3）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 2 回以上でないと差異にしない（1 回は誤操作・鍵の再発行がありうる）
 *   - **`STAFF_KEY` / `MASTER_KEY` だけなら差異にしない**（業務上の入室）
 *   - 深夜帯は `localHour` で判定する（engine は時差を解けない）
 *   - R001 との統合は `evaluate()` の担当（ここでは行わない）
 */

import { describe, expect, it } from "vitest";

import { UNKNOWN_ACTOR_CONFIDENCE_PENALTY } from "../staffKey.js";

import {
  R002,
  R002_BASE_CONFIDENCE,
  R002_LATE_NIGHT_BONUS,
  R002_MANY_UNLOCKS_BONUS,
  guestUnlocksOf,
  isLateNight,
} from "./R002.js";
import { occupancyFact, ruleContext, signalFact, taskFact } from "./testContext.js";

/** 空室なのに解錠がある文脈。 */
function unlocked(count: number, overrides: Parameters<typeof ruleContext>[0] = {}) {
  return ruleContext({
    occupancy: occupancyFact({ isOccupied: false, guestCount: 0, reservationRef: null }),
    signals: Array.from({ length: count }, (_, index) =>
      signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00") + index * 60_000 }),
    ),
    ...overrides,
  });
}

describe("R002 — 正例（差異になる）", () => {
  it("空室に宿泊者の鍵で 2 回解錠されていれば差異", () => {
    const finding = R002.evaluate(unlocked(2));
    expect(finding?.ruleCode).toBe("R002");
    expect(finding?.severity).toBe("HIGH");
    expect(finding?.confidence).toBe(R002_BASE_CONFIDENCE);
  });

  it("4 回以上なら +20", () => {
    expect(R002.evaluate(unlocked(4))?.confidence).toBe(
      R002_BASE_CONFIDENCE + R002_MANY_UNLOCKS_BONUS,
    );
  });

  it("深夜帯を含むなら +15", () => {
    const finding = R002.evaluate(
      unlocked(2, {
        signals: [signalFact({ localHour: 2 }), signalFact({ localHour: 22 })],
      }),
    );
    expect(finding?.confidence).toBe(R002_BASE_CONFIDENCE + R002_LATE_NIGHT_BONUS);
    expect(finding?.matchedSignals).toContain("LATE_NIGHT_UNLOCK");
  });

  it("`MOBILE_KEY` も宿泊者の鍵として数える（§3.3）", () => {
    const finding = R002.evaluate(
      unlocked(2, {
        signals: [signalFact({ actorType: "MOBILE_KEY" }), signalFact({ actorType: "GUEST_KEY" })],
      }),
    );
    expect(finding).not.toBeNull();
  });

  it("解錠の記録を根拠に残す", () => {
    const finding = R002.evaluate(unlocked(3));
    expect(finding?.evidence["unlockCount"]).toBe(3);
    expect(Array.isArray(finding?.evidence["signals"])).toBe(true);
  });

  it("職員の鍵が混ざっていても、宿泊者の鍵が 2 回あれば差異", () => {
    const finding = R002.evaluate(
      unlocked(2, {
        signals: [
          signalFact({ actorType: "STAFF_KEY" }),
          signalFact({ actorType: "GUEST_KEY" }),
          signalFact({ actorType: "GUEST_KEY" }),
        ],
      }),
    );
    expect(finding).not.toBeNull();
  });
});

describe("R002 — 負例（差異にしない）", () => {
  it("解錠が 1 回だけなら差異にしない", () => {
    expect(R002.evaluate(unlocked(1))).toBeNull();
  });

  it("**職員・マスターキーだけなら差異にしない**（§3.3）", () => {
    expect(
      R002.evaluate(
        unlocked(2, {
          signals: [
            signalFact({ actorType: "STAFF_KEY" }),
            signalFact({ actorType: "MASTER_KEY" }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("稼働している日は差異にしない", () => {
    expect(R002.evaluate(unlocked(4, { occupancy: occupancyFact({ isOccupied: true }) }))).toBeNull();
  });

  it("自社利用・招待は差異にしない", () => {
    expect(
      R002.evaluate(
        unlocked(4, { occupancy: occupancyFact({ isOccupied: false, isHouseUse: true }) }),
      ),
    ).toBeNull();
  });

  it("入室記録があれば差異にしない", () => {
    expect(
      R002.evaluate(
        unlocked(4, {
          accessLogs: [{ purpose: "MAINTENANCE", enteredAt: 0, exitedAt: null }],
        }),
      ),
    ).toBeNull();
  });

  it("販売していない客室は差異にしない", () => {
    expect(
      R002.evaluate(
        unlocked(4, {
          room: {
            id: "o7k2m9__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
            number: "302",
            roomTypeId: "",
            saleStatus: "OUT_OF_ORDER",
          },
        }),
      ),
    ).toBeNull();
  });

  it("解錠以外のシグナルは数えない", () => {
    expect(
      R002.evaluate(
        unlocked(2, {
          signals: [signalFact({ signalType: "WIFI_JOIN" }), signalFact({ signalType: "POWER_ON" })],
        }),
      ),
    ).toBeNull();
  });

  it("稼働記録が無ければ差異にしない", () => {
    expect(R002.evaluate(unlocked(4, { occupancy: null }))).toBeNull();
  });
});

describe("isLateNight / guestUnlocksOf", () => {
  it("0 時〜5 時が深夜帯（5 時は含まない）", () => {
    expect(isLateNight(signalFact({ localHour: 0 }))).toBe(true);
    expect(isLateNight(signalFact({ localHour: 4 }))).toBe(true);
    expect(isLateNight(signalFact({ localHour: 5 }))).toBe(false);
    expect(isLateNight(signalFact({ localHour: 23 }))).toBe(false);
  });

  it("**地域時刻が分からなければ偽**（推測しない）", () => {
    expect(isLateNight(signalFact({ localHour: null }))).toBe(false);
  });

  /**
   * **P6-08 で変わった**（PK-SPEC-P6 §4.3）。
   *
   * 元は「鍵の種別が無い解錠は数えない」だった。多くのロックは
   * `actorType` を返さず、数えない実装ではそういう機種で R002 が一度も
   * 立たない。§4.3 が confidence の減点（−25）を定めているのは、
   * **不明でも立てたうえで弱く出す**ことを求めているため。
   */
  it("鍵の種別が無い解錠も数える（§4.3。宿泊者の鍵とみなしたのではない）", () => {
    expect(guestUnlocksOf([signalFact({ actorType: null })])).toHaveLength(1);
    expect(guestUnlocksOf([signalFact({ actorType: "UNKNOWN" })])).toHaveLength(1);
  });

  it("スタッフの鍵は数えない", () => {
    expect(guestUnlocksOf([signalFact({ actorType: "STAFF_KEY" })])).toHaveLength(0);
    expect(guestUnlocksOf([signalFact({ actorType: "MASTER_KEY" })])).toHaveLength(0);
  });
});

/**
 * P6-08 — スタッフキー除外と `actorType` 不明（PK-SPEC-P6 §4.3・§4.4）。
 *
 * 窓の境界そのものは `staffKey.spec.ts` が見る。ここは
 * **R002 の結論がどう変わるか**だけを見る。
 */
describe("R002 — 清掃時刻による除外（§4.4）", () => {
  const startedAt = Date.parse("2026-09-09T10:00:00+09:00");
  const completedAt = Date.parse("2026-09-09T10:40:00+09:00");

  /** 清掃の直前・直後に 1 回ずつ解錠がある文脈。 */
  function aroundCleaning(overrides: Parameters<typeof ruleContext>[0] = {}) {
    return ruleContext({
      occupancy: occupancyFact({ isOccupied: false, guestCount: 0, reservationRef: null }),
      task: taskFact({ startedAt, completedAt }),
      signals: [
        signalFact({ occurredAt: startedAt - 2 * 60_000, actorType: null, localHour: 9 }),
        signalFact({ occurredAt: completedAt + 2 * 60_000, actorType: null, localHour: 10 }),
      ],
      ...overrides,
    });
  }

  it("清掃の前後 10 分の解錠だけなら差異にしない", () => {
    expect(R002.evaluate(aroundCleaning())).toBeNull();
  });

  it("清掃の窓を外れた解錠が 2 回あれば差異になる", () => {
    const finding = R002.evaluate(
      aroundCleaning({
        signals: [
          signalFact({ occurredAt: startedAt - 2 * 60_000, actorType: null, localHour: 9 }),
          signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00"), localHour: 22 }),
          signalFact({ occurredAt: Date.parse("2026-09-09T22:30:00+09:00"), localHour: 22 }),
        ],
      }),
    );
    expect(finding?.evidence["unlockCount"]).toBe(2);
  });

  it("スタッフの鍵は窓の外でも外れる（方法 1 も掛ける）", () => {
    const finding = R002.evaluate(
      aroundCleaning({
        signals: [
          signalFact({
            occurredAt: Date.parse("2026-09-09T15:00:00+09:00"),
            actorType: "STAFF_KEY",
            localHour: 15,
          }),
          signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00"), localHour: 22 }),
        ],
      }),
    );
    expect(finding).toBeNull(); // 残るのは 1 回だけ
  });

  it("清掃タスクが無ければ何も外さない", () => {
    const finding = R002.evaluate(aroundCleaning({ task: null }));
    expect(finding?.evidence["unlockCount"]).toBe(2);
  });
});

describe("R002 — `actorType` 不明の減点（§4.3）", () => {
  it("不明が混ざれば確信度が 25 下がる", () => {
    const known = R002.evaluate(unlocked(2));
    const unknown = R002.evaluate(
      unlocked(2, {
        signals: [
          signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00"), actorType: null }),
          signalFact({ occurredAt: Date.parse("2026-09-09T22:01:00+09:00"), actorType: "UNKNOWN" }),
        ],
      }),
    );
    expect(known?.confidence).toBe(R002_BASE_CONFIDENCE);
    expect(unknown?.confidence).toBe(R002_BASE_CONFIDENCE + UNKNOWN_ACTOR_CONFIDENCE_PENALTY);
  });

  it("不明であることを根拠に残す（W-07 の「取得できていません」）", () => {
    const unknown = R002.evaluate(
      unlocked(2, {
        signals: [
          signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00"), actorType: null }),
          signalFact({ occurredAt: Date.parse("2026-09-09T22:01:00+09:00"), actorType: null }),
        ],
      }),
    );
    expect(unknown?.evidence["actorTypeUnknown"]).toBe(true);
    // **不明を `GUEST_KEY` に書き換えていない**（§4.3 MUST）。
    expect(unknown?.evidence["signals"]).toMatchObject([{ actorType: null }, { actorType: null }]);
  });

  it("種別が取れていれば旗は立たない", () => {
    expect(R002.evaluate(unlocked(2))?.evidence["actorTypeUnknown"]).toBe(false);
  });

  it("減点で `matchedSignals` は増えない（単一シグナルの上限を緩めない）", () => {
    const unknown = R002.evaluate(
      unlocked(2, {
        signals: [
          signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00"), actorType: null }),
          signalFact({ occurredAt: Date.parse("2026-09-09T22:01:00+09:00"), actorType: null }),
        ],
      }),
    );
    expect(unknown?.matchedSignals).toEqual(["GUEST_KEY_UNLOCK"]);
  });
});
