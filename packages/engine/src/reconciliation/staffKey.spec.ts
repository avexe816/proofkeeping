/**
 * スタッフキー除外と `actorType` 不明の扱い（P6-08 / PK-SPEC-P6 §4.3・§4.4）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import { signalFact, taskFact } from "./rules/testContext.js";
import {
  CLEANING_WINDOW_MS,
  UNKNOWN_ACTOR_CONFIDENCE_PENALTY,
  excludeStaffAccess,
  isActorTypeUnknown,
  isStaffActor,
  isWithinCleaningWindow,
  unknownActorPenalty,
} from "./staffKey.js";

const STARTED_AT = Date.parse("2026-09-09T10:00:00+09:00");
const COMPLETED_AT = Date.parse("2026-09-09T10:40:00+09:00");

const task = taskFact({ startedAt: STARTED_AT, completedAt: COMPLETED_AT });

describe("isActorTypeUnknown — 正例（不明）", () => {
  it("null は不明", () => {
    expect(isActorTypeUnknown(signalFact({ actorType: null }))).toBe(true);
  });

  it("UNKNOWN は不明", () => {
    expect(isActorTypeUnknown(signalFact({ actorType: "UNKNOWN" }))).toBe(true);
  });

  it("省略と UNKNOWN を区別しない", () => {
    expect(isActorTypeUnknown(signalFact({ actorType: null }))).toBe(
      isActorTypeUnknown(signalFact({ actorType: "UNKNOWN" })),
    );
  });

  it("種別を問わず DOOR_UNLOCK 以外でも判定できる", () => {
    expect(isActorTypeUnknown(signalFact({ signalType: "KEY_ISSUE", actorType: null }))).toBe(true);
  });

  it("不明は「スタッフの鍵」ではない", () => {
    expect(isStaffActor(signalFact({ actorType: null }))).toBe(false);
  });
});

describe("isActorTypeUnknown — 負例（不明ではない）", () => {
  it.each(["GUEST_KEY", "STAFF_KEY", "MASTER_KEY", "MOBILE_KEY"] as const)(
    "%s は不明ではない",
    (actorType) => {
      expect(isActorTypeUnknown(signalFact({ actorType }))).toBe(false);
    },
  );

  it("GUEST_KEY はスタッフの鍵でもない", () => {
    expect(isStaffActor(signalFact({ actorType: "GUEST_KEY" }))).toBe(false);
  });
});

describe("isStaffActor（§4.4 の方法 1）", () => {
  it("STAFF_KEY はスタッフの鍵", () => {
    expect(isStaffActor(signalFact({ actorType: "STAFF_KEY" }))).toBe(true);
  });

  it("MASTER_KEY はスタッフの鍵", () => {
    expect(isStaffActor(signalFact({ actorType: "MASTER_KEY" }))).toBe(true);
  });

  it("MOBILE_KEY はスタッフの鍵ではない", () => {
    expect(isStaffActor(signalFact({ actorType: "MOBILE_KEY" }))).toBe(false);
  });
});

describe("isWithinCleaningWindow — 正例（外す）", () => {
  it("開始のちょうどその時刻", () => {
    expect(isWithinCleaningWindow(signalFact({ occurredAt: STARTED_AT }), task)).toBe(true);
  });

  it("開始の 10 分前（境界は含む）", () => {
    const signal = signalFact({ occurredAt: STARTED_AT - CLEANING_WINDOW_MS });
    expect(isWithinCleaningWindow(signal, task)).toBe(true);
  });

  it("開始の 10 分後", () => {
    const signal = signalFact({ occurredAt: STARTED_AT + CLEANING_WINDOW_MS });
    expect(isWithinCleaningWindow(signal, task)).toBe(true);
  });

  it("完了の 3 分前", () => {
    const signal = signalFact({ occurredAt: COMPLETED_AT - 3 * 60 * 1000 });
    expect(isWithinCleaningWindow(signal, task)).toBe(true);
  });

  it("完了の 10 分後（境界は含む）", () => {
    const signal = signalFact({ occurredAt: COMPLETED_AT + CLEANING_WINDOW_MS });
    expect(isWithinCleaningWindow(signal, task)).toBe(true);
  });

  it("開始しか無いタスクでも開始の窓は効く", () => {
    const started = taskFact({ startedAt: STARTED_AT, completedAt: null });
    expect(isWithinCleaningWindow(signalFact({ occurredAt: STARTED_AT }), started)).toBe(true);
  });
});

describe("isWithinCleaningWindow — 負例（外さない）", () => {
  it("開始の 11 分前", () => {
    const signal = signalFact({ occurredAt: STARTED_AT - CLEANING_WINDOW_MS - 60_000 });
    expect(isWithinCleaningWindow(signal, task)).toBe(false);
  });

  it("完了の 11 分後", () => {
    const signal = signalFact({ occurredAt: COMPLETED_AT + CLEANING_WINDOW_MS + 60_000 });
    expect(isWithinCleaningWindow(signal, task)).toBe(false);
  });

  it("清掃の途中（開始 +20 分・完了 −20 分）は窓の外", () => {
    const signal = signalFact({ occurredAt: STARTED_AT + 20 * 60 * 1000 });
    expect(isWithinCleaningWindow(signal, task)).toBe(false);
  });

  it("タスクが無ければ外さない", () => {
    expect(isWithinCleaningWindow(signalFact({ occurredAt: STARTED_AT }), null)).toBe(false);
  });

  it("開始も完了も無ければ外さない", () => {
    const empty = taskFact({ startedAt: null, completedAt: null });
    expect(isWithinCleaningWindow(signalFact({ occurredAt: STARTED_AT }), empty)).toBe(false);
  });
});

describe("excludeStaffAccess", () => {
  it("スタッフの鍵と清掃の窓の両方を外す", () => {
    const signals = [
      signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00"), actorType: "GUEST_KEY" }),
      signalFact({ occurredAt: STARTED_AT + 60_000, actorType: null }),
      signalFact({ occurredAt: Date.parse("2026-09-09T15:00:00+09:00"), actorType: "STAFF_KEY" }),
    ];
    const kept = excludeStaffAccess(signals, task);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.actorType).toBe("GUEST_KEY");
  });

  it("並びを入れ替えない（§10.1 の決定性）", () => {
    const a = signalFact({ occurredAt: Date.parse("2026-09-09T23:00:00+09:00") });
    const b = signalFact({ occurredAt: Date.parse("2026-09-09T21:00:00+09:00") });
    expect(excludeStaffAccess([a, b], task)).toEqual([a, b]);
  });

  it("外すものが無ければそのまま返す", () => {
    const signals = [signalFact({ occurredAt: Date.parse("2026-09-09T22:00:00+09:00") })];
    expect(excludeStaffAccess(signals, null)).toEqual(signals);
  });
});

describe("unknownActorPenalty（§4.3）", () => {
  it("不明が 1 件あれば 25 下げる", () => {
    expect(unknownActorPenalty([signalFact({ actorType: null })])).toBe(
      UNKNOWN_ACTOR_CONFIDENCE_PENALTY,
    );
  });

  it("不明が 4 件あっても 25 のまま（件数に比例させない）", () => {
    const signals = [null, null, "UNKNOWN", null].map((actorType) =>
      signalFact({ actorType: actorType as null }),
    );
    expect(unknownActorPenalty(signals)).toBe(UNKNOWN_ACTOR_CONFIDENCE_PENALTY);
  });

  it("すべて種別が取れていれば 0", () => {
    expect(unknownActorPenalty([signalFact({ actorType: "GUEST_KEY" })])).toBe(0);
  });

  it("1 件も無ければ 0", () => {
    expect(unknownActorPenalty([])).toBe(0);
  });

  it("減点は負の値（足し算で使う）", () => {
    expect(UNKNOWN_ACTOR_CONFIDENCE_PENALTY).toBeLessThan(0);
  });
});
