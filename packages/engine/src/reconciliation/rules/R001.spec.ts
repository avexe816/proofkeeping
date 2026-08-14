/**
 * R001 — 稼働記録のない使用痕跡（P4-04 / PK-SPEC-P4 §3.2）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を各 5 件以上）
 *
 * ── 2 つの層を分けて確かめる ────────────────────────────
 * `R001.evaluate()` を直に呼ぶ検査は**素の判定**（条件と素の確信度）。
 * `evaluate()` 経由の検査は**調整込みの結果**（§1.3 の単一シグナル上限、
 * §4.2 の −20）。task の完了条件はどちらも後者に掛かっている。
 */

import { describe, expect, it } from "vitest";

import { SINGLE_SIGNAL_CONFIDENCE_CAP, USED_DEFAULTS_PENALTY } from "../confidence.js";
import { evaluate } from "../evaluate.js";
import type { ObservationFact, OccupancyFact, RuleContext } from "../types.js";

import { R001, hasAnyAmenityUsed, matchedSignalsOf } from "./R001.js";

const NOW = new Date("2026-09-10T02:00:00+09:00");
const RECORDED_AT = Date.parse("2026-09-09T10:22:00+09:00");

/** 痕跡が 4 つ揃った観察（§6.2 の画面例と同じ形）。 */
function observation(overrides: Partial<ObservationFact> = {}): ObservationFact {
  return {
    skipped: false,
    bedsUsed: 1,
    trashLevel: "NORMAL",
    bathTowelUsed: 2,
    faceTowelUsed: 0,
    handTowelUsed: 0,
    bathMatUsed: 1,
    slippersUsed: 0,
    cupsUsed: 0,
    extraFutonUsed: 0,
    amenitiesUsed: {},
    usedDefaults: false,
    recordedAt: RECORDED_AT,
    recordedById: "o7k2m9__mbr_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
    ...overrides,
  };
}

/** 痕跡が 1 つだけの観察（単一シグナルの検査に使う）。 */
function singleSignalObservation(overrides: Partial<ObservationFact> = {}): ObservationFact {
  return observation({
    bedsUsed: 1,
    trashLevel: "NONE",
    bathTowelUsed: 0,
    bathMatUsed: 0,
    ...overrides,
  });
}

/** 空室として取り込まれた稼働記録。 */
function occupancy(overrides: Partial<OccupancyFact> = {}): OccupancyFact {
  return {
    isOccupied: false,
    guestCount: 0,
    reservationRef: null,
    source: "CSV_IMPORT",
    importedAt: Date.parse("2026-09-10T02:14:00+09:00"),
    checkInAt: null,
    checkOutAt: null,
    isStayover: false,
    nightsTotal: null,
    nightIndex: null,
    isComplimentary: false,
    isHouseUse: false,
    ...overrides,
  };
}

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    now: NOW,
    businessDate: "2026-09-09",
    property: {
      id: "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      occupancyLinked: true,
      daysSinceOperationStart: 400,
    },
    room: {
      id: "o7k2m9__room_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      number: "302",
      roomTypeId: "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      saleStatus: "ON_SALE",
    },
    occupancy: occupancy(),
    observation: observation(),
    task: null,
    signals: [],
    accessLogs: [],
    baselines: [],
    previousObservation: null,
    thresholds: {},
    ...overrides,
  };
}

describe("R001 — 正例（差異を返す）", () => {
  it("① 空室の記録に 4 種類の痕跡 → HIGH・確信度 95", () => {
    const draft = R001.evaluate(context());
    expect(draft?.severity).toBe("HIGH");
    expect(draft?.confidence).toBe(95);
    expect(draft?.matchedSignals).toEqual([
      "BEDS_USED",
      "TRASH_PRESENT",
      "TOWEL_USED",
      "BATHMAT_USED",
    ]);
  });

  it("② ベッドだけ → MEDIUM・素の確信度 50（35 + 15）", () => {
    const draft = R001.evaluate(context({ observation: singleSignalObservation() }));
    expect(draft?.severity).toBe("MEDIUM");
    expect(draft?.confidence).toBe(50);
    expect(draft?.matchedSignals).toEqual(["BEDS_USED"]);
  });

  it("③ ゴミが多い（HIGH）だけでも痕跡として数える", () => {
    const draft = R001.evaluate(
      context({ observation: singleSignalObservation({ bedsUsed: 0, trashLevel: "HIGH" }) }),
    );
    expect(draft?.matchedSignals).toEqual(["TRASH_PRESENT"]);
  });

  it("④ アメニティの使用だけでも痕跡として数える", () => {
    const draft = R001.evaluate(
      context({
        observation: singleSignalObservation({ bedsUsed: 0, amenitiesUsed: { RAZOR: 1 } }),
      }),
    );
    expect(draft?.matchedSignals).toEqual(["AMENITY_USED"]);
  });

  it("⑤ ベッド + タオルの 2 種類なら HIGH（§3.2 の 2 つ以上）", () => {
    const draft = R001.evaluate(
      context({ observation: singleSignalObservation({ bathTowelUsed: 2 }) }),
    );
    expect(draft?.severity).toBe("HIGH");
    expect(draft?.confidence).toBe(65);
  });

  it("⑥ 3 系統の根拠を evidence に載せる（§6.2 が並べる）", () => {
    const draft = R001.evaluate(context());
    expect(draft?.evidence["occupancy"]).toMatchObject({
      isOccupied: false,
      source: "CSV_IMPORT",
    });
    expect(draft?.evidence["observation"]).toMatchObject({ recordedAt: RECORDED_AT });
    expect(draft?.evidence["room"]).toMatchObject({ number: "302" });
  });

  it("⑦ 部屋番号を表題に出す（§3.2）", () => {
    expect(R001.evaluate(context())?.title).toBe("302 号室：稼働記録のない使用痕跡");
  });
});

describe("R001 — 負例（差異を返さない）", () => {
  it("① 稼働記録が「稼働」なら該当しない", () => {
    expect(R001.evaluate(context({ occupancy: occupancy({ isOccupied: true }) }))).toBeNull();
  });

  it("② 稼働記録そのものが無い日は該当しない（R006 の担当）", () => {
    expect(R001.evaluate(context({ occupancy: null }))).toBeNull();
  });

  it("③ 自社利用・招待は該当しない（§4.1）", () => {
    expect(R001.evaluate(context({ occupancy: occupancy({ isHouseUse: true }) }))).toBeNull();
    expect(R001.evaluate(context({ occupancy: occupancy({ isComplimentary: true }) }))).toBeNull();
  });

  it("④ 観察を記録しなかった日は該当しない（記録しないことを差異にしない）", () => {
    expect(R001.evaluate(context({ observation: observation({ skipped: true }) }))).toBeNull();
    expect(R001.evaluate(context({ observation: null }))).toBeNull();
  });

  it("⑤ 痕跡が 1 つも無ければ該当しない", () => {
    expect(
      R001.evaluate(
        context({
          observation: observation({
            bedsUsed: 0,
            trashLevel: "NONE",
            bathTowelUsed: 0,
            bathMatUsed: 0,
          }),
        }),
      ),
    ).toBeNull();
  });

  it("⑥ ゴミが「少ない」だけは痕跡にしない（§3.2 は NORMAL / HIGH）", () => {
    expect(
      R001.evaluate(
        context({ observation: singleSignalObservation({ bedsUsed: 0, trashLevel: "LOW" }) }),
      ),
    ).toBeNull();
  });

  it("⑦ 販売していない客室は該当しない（§4.1）", () => {
    const base = context();
    expect(
      R001.evaluate(context({ room: { ...base.room, saleStatus: "MAINTENANCE" } })),
    ).toBeNull();
    expect(
      R001.evaluate(context({ room: { ...base.room, saleStatus: "OUT_OF_ORDER" } })),
    ).toBeNull();
  });

  it("⑧ 正当な入室が登録済みなら該当しない（§4.1）", () => {
    expect(
      R001.evaluate(
        context({ accessLogs: [{ purpose: "INSPECTION", enteredAt: RECORDED_AT, exitedAt: null }] }),
      ),
    ).toBeNull();
  });
});

describe("R001 — evaluate() 経由の調整（task の完了条件）", () => {
  it("usedDefaults = true で確信度が 20 下がる", () => {
    const plain = evaluate(context(), {}, [R001]).findings[0];
    const defaulted = evaluate(context({ observation: observation({ usedDefaults: true }) }), {}, [
      R001,
    ]).findings[0];

    expect(plain?.confidence).toBe(95);
    expect(defaulted?.confidence).toBe(95 + USED_DEFAULTS_PENALTY);
  });

  it("単一シグナルでは確信度が 80 以上にならない", () => {
    // 素の確信度を上げても（施設の設定・将来の加点があっても）上限が効く。
    const result = evaluate(context({ observation: singleSignalObservation() }), {}, [R001]);
    expect(result.findings[0]?.matchedSignals).toHaveLength(1);
    expect(result.findings[0]?.confidence).toBeLessThan(80);
    expect(result.findings[0]?.confidence).toBeLessThanOrEqual(SINGLE_SIGNAL_CONFIDENCE_CAP);
  });

  it("同じ入力を 3 回評価しても同じ結果（§10.1）", () => {
    const runs = [1, 2, 3].map(() => evaluate(context(), {}, [R001]));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

describe("hasAnyAmenityUsed / matchedSignalsOf", () => {
  it("個数でも真偽でも「使った」を読む", () => {
    expect(hasAnyAmenityUsed({})).toBe(false);
    expect(hasAnyAmenityUsed({ RAZOR: 0 })).toBe(false);
    expect(hasAnyAmenityUsed({ RAZOR: false })).toBe(false);
    expect(hasAnyAmenityUsed({ RAZOR: 2 })).toBe(true);
    expect(hasAnyAmenityUsed({ RAZOR: true })).toBe(true);
  });

  it("痕跡の並びが入力に依らず固定（§10.1）", () => {
    expect(matchedSignalsOf(observation({ amenitiesUsed: { RAZOR: 1 } }))).toEqual([
      "BEDS_USED",
      "TRASH_PRESENT",
      "TOWEL_USED",
      "BATHMAT_USED",
      "AMENITY_USED",
    ]);
  });
});
