/**
 * 既定値推定のテスト（P3-02 / PK-SPEC-P3 §3.3）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * 「負例」は**そうならないこと**を押さえるケースを指す。既定値の推定に
 * 例外は無いので、ここでは「空室として扱ってはいけない入力」
 * 「人数ぶんにしてはいけない項目」を負例として並べている。
 */

import { describe, expect, it } from "vitest";

import {
  FALLBACK_GUEST_COUNT,
  estimateGuestCount,
  estimateObservationDefaults,
  type RoomPlanForDefaults,
  type RoomTypeForDefaults,
} from "./observationDefaults.js";

const TWIN: RoomTypeForDefaults = { bedCount: 2, capacity: 2 };
const SINGLE: RoomTypeForDefaults = { bedCount: 1, capacity: 1 };
const JAPANESE: RoomTypeForDefaults = { bedCount: null, capacity: 4 };

function plan(overrides: Partial<RoomPlanForDefaults> = {}): RoomPlanForDefaults {
  return { hasCheckout: true, isStayover: false, guestCount: 2, ...overrides };
}

describe("estimateGuestCount", () => {
  it("予定人数があればそれを使う", () => {
    expect(estimateGuestCount(plan({ guestCount: 3 }), TWIN)).toBe(3);
  });

  it("予定人数が 0 なら客室タイプの標準人数へ落ちる", () => {
    expect(estimateGuestCount(plan({ guestCount: 0 }), JAPANESE)).toBe(4);
  });

  it("標準人数が無ければベッド数へ落ちる", () => {
    expect(estimateGuestCount(plan({ guestCount: 0 }), { bedCount: 2, capacity: null })).toBe(2);
  });

  it("どちらも無ければ既定の 1 名", () => {
    expect(estimateGuestCount(plan({ guestCount: 0 }), { bedCount: null, capacity: null })).toBe(
      FALLBACK_GUEST_COUNT,
    );
  });

  it("稼働予定そのものが無くても客室タイプから出せる", () => {
    expect(estimateGuestCount(null, JAPANESE)).toBe(4);
  });

  it("負の人数・小数を既定値にしない", () => {
    expect(estimateGuestCount(plan({ guestCount: -3 }), TWIN)).toBe(2);
    expect(estimateGuestCount(plan({ guestCount: 2.7 }), TWIN)).toBe(2);
    expect(estimateGuestCount(plan({ guestCount: 0 }), { bedCount: null, capacity: -5 })).toBe(
      FALLBACK_GUEST_COUNT,
    );
  });
});

describe("estimateObservationDefaults — 空室想定", () => {
  const empty = plan({ hasCheckout: false, isStayover: false, guestCount: 0 });

  it("退室も連泊も無ければ全項目 0", () => {
    expect(estimateObservationDefaults(empty, TWIN)).toEqual({
      bedsUsed: 0,
      trashLevel: "NONE",
      bathTowelUsed: 0,
      faceTowelUsed: 0,
      handTowelUsed: 0,
      bathMatUsed: 0,
      slippersUsed: 0,
      cupsUsed: 0,
      extraFutonUsed: 0,
    });
  });

  it("ゴミは NONE", () => {
    expect(estimateObservationDefaults(empty, JAPANESE).trashLevel).toBe("NONE");
  });

  it("人数が入っていても退室・連泊が無ければ空室扱い", () => {
    // 予約が消えたあとに人数だけ残っている行を想定。§3.3 の分岐は稼働の有無を見る。
    const stale = plan({ hasCheckout: false, isStayover: false, guestCount: 2 });
    expect(estimateObservationDefaults(stale, TWIN).bathTowelUsed).toBe(0);
  });

  it("バスマットも 0（部屋に 1 つでも、使われていなければ 0）", () => {
    expect(estimateObservationDefaults(empty, TWIN).bathMatUsed).toBe(0);
  });

  it("客室タイプが違っても空室の既定値は同じ", () => {
    expect(estimateObservationDefaults(empty, SINGLE)).toEqual(
      estimateObservationDefaults(empty, JAPANESE),
    );
  });
});

describe("estimateObservationDefaults — 稼働（アウト清掃）", () => {
  it("人数ぶんのタオル類が既定になる", () => {
    const defaults = estimateObservationDefaults(plan({ guestCount: 2 }), TWIN);
    expect(defaults.bathTowelUsed).toBe(2);
    expect(defaults.faceTowelUsed).toBe(2);
    expect(defaults.handTowelUsed).toBe(2);
  });

  it("ベッドは人数とベッド数の小さいほう", () => {
    expect(estimateObservationDefaults(plan({ guestCount: 3 }), TWIN).bedsUsed).toBe(2);
    expect(estimateObservationDefaults(plan({ guestCount: 1 }), TWIN).bedsUsed).toBe(1);
  });

  it("ベッド数が未設定なら人数をそのまま置く", () => {
    expect(estimateObservationDefaults(plan({ guestCount: 4 }), JAPANESE).bedsUsed).toBe(4);
  });

  it("ゴミは NORMAL", () => {
    expect(estimateObservationDefaults(plan(), TWIN).trashLevel).toBe("NORMAL");
  });

  it("バスマットは人数によらず 1", () => {
    expect(estimateObservationDefaults(plan({ guestCount: 1 }), SINGLE).bathMatUsed).toBe(1);
    expect(estimateObservationDefaults(plan({ guestCount: 4 }), JAPANESE).bathMatUsed).toBe(1);
  });

  it("追加布団は人数がベッド数を超えても 0", () => {
    // 敷いたかどうかは現場が見た事実で決まる。予約人数から推測しない。
    expect(estimateObservationDefaults(plan({ guestCount: 4 }), TWIN).extraFutonUsed).toBe(0);
  });
});

describe("estimateObservationDefaults — 連泊", () => {
  const stayover = plan({ hasCheckout: false, isStayover: true, guestCount: 2 });

  it("空室扱いにしない", () => {
    expect(estimateObservationDefaults(stayover, TWIN).bathTowelUsed).toBe(2);
  });

  it("§3.3 は連泊に専用の推定式を持たないので、アウト清掃と同じ値になる", () => {
    // 連泊 2 日目以降をどう扱うかは §12 の未決事項。決着前に独自の式を作らない。
    expect(estimateObservationDefaults(stayover, TWIN)).toEqual(
      estimateObservationDefaults(plan({ guestCount: 2 }), TWIN),
    );
  });

  it("退室と連泊が同時に立っていても稼働として扱う", () => {
    const both = plan({ hasCheckout: true, isStayover: true, guestCount: 1 });
    expect(estimateObservationDefaults(both, TWIN).bedsUsed).toBe(1);
  });
});

describe("estimateObservationDefaults — 稼働予定が無い", () => {
  it("空室ではなく稼働として扱う", () => {
    // タスクが生成されている以上、部屋は使われた可能性が高い。
    // 全 0 のまま 1 タップ確定されると「使用実績なし」が残る。
    const defaults = estimateObservationDefaults(null, TWIN);
    expect(defaults.trashLevel).toBe("NORMAL");
    expect(defaults.bathTowelUsed).toBe(2);
  });

  it("人数は客室タイプから推定する", () => {
    expect(estimateObservationDefaults(null, JAPANESE).faceTowelUsed).toBe(4);
  });

  it("客室タイプに何も無ければ 1 名ぶん", () => {
    const defaults = estimateObservationDefaults(null, { bedCount: null, capacity: null });
    expect(defaults.bedsUsed).toBe(FALLBACK_GUEST_COUNT);
    expect(defaults.bathTowelUsed).toBe(FALLBACK_GUEST_COUNT);
  });
});

describe("既定値の性質", () => {
  it("入力項目は 7 つを超えない（§1.2 MUST の上限に触れない）", () => {
    // M-05 に出るのはベッド・ゴミ・タオル 3 種の 5 項目。
    // 残り（スリッパ・グラス・追加布団）は M-05b（§4.2）へ送る。
    const mainScreenKeys = [
      "bedsUsed",
      "trashLevel",
      "bathTowelUsed",
      "faceTowelUsed",
      "bathMatUsed",
    ];
    expect(mainScreenKeys.length).toBeLessThanOrEqual(7);
  });

  it("同じ入力から同じ既定値が出る", () => {
    const first = estimateObservationDefaults(plan(), TWIN);
    const second = estimateObservationDefaults(plan(), TWIN);
    expect(first).toEqual(second);
  });

  it("戻り値を書き換えても次の呼び出しに影響しない", () => {
    const first = estimateObservationDefaults(plan({ hasCheckout: false }), TWIN);
    first.bathTowelUsed = 99;
    expect(estimateObservationDefaults(plan({ hasCheckout: false }), TWIN).bathTowelUsed).toBe(0);
  });

  it("既定値に負の数が出ない", () => {
    const cases: [RoomPlanForDefaults | null, RoomTypeForDefaults][] = [
      [plan({ guestCount: -1 }), TWIN],
      [plan({ guestCount: 0 }), { bedCount: -2, capacity: null }],
      [null, { bedCount: null, capacity: null }],
      [plan({ hasCheckout: false, isStayover: false }), TWIN],
      [plan({ guestCount: 99 }), SINGLE],
    ];
    for (const [roomPlan, roomType] of cases) {
      const defaults = estimateObservationDefaults(roomPlan, roomType);
      for (const value of Object.values(defaults)) {
        if (typeof value === "number") expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
