/**
 * R006 — 稼働記録なしの清掃発生（P4-04 / PK-SPEC-P4 §3.7）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を各 5 件以上）
 *
 * **見ているのは連携の欠落**であって現場ではない（§3.7 の「用途」）。
 * 負例が「清掃も稼働記録もある通常の日」ではなく、**「記録が無いことが
 * 正常な状態」**に寄っているのはそのため。
 */

import { describe, expect, it } from "vitest";

import { evaluate } from "../evaluate.js";
import type { ObservationFact, OccupancyFact, RuleContext, TaskFact } from "../types.js";

import { R006, R006_CONFIDENCE } from "./R006.js";

const NOW = new Date("2026-09-10T02:00:00+09:00");
const COMPLETED_AT = Date.parse("2026-09-09T11:40:00+09:00");

function observation(overrides: Partial<ObservationFact> = {}): ObservationFact {
  return {
    skipped: false,
    bedsUsed: 0,
    trashLevel: "NONE",
    bathTowelUsed: 0,
    faceTowelUsed: 0,
    handTowelUsed: 0,
    bathMatUsed: 0,
    slippersUsed: 0,
    cupsUsed: 0,
    extraFutonUsed: 0,
    amenitiesUsed: {},
    usedDefaults: false,
    recordedAt: Date.parse("2026-09-09T10:22:00+09:00"),
    recordedById: "o7k2m9__mbr_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
    ...overrides,
  };
}

function task(overrides: Partial<TaskFact> = {}): TaskFact {
  return {
    taskType: "CHECKOUT",
    isCompleted: true,
    completedAt: COMPLETED_AT,
    actualMinutes: 32,
    photoCount: 3,
    ...overrides,
  };
}

function occupancy(overrides: Partial<OccupancyFact> = {}): OccupancyFact {
  return {
    isOccupied: true,
    guestCount: 2,
    reservationRef: "RSV-0001",
    source: "CSV_IMPORT",
    importedAt: Date.parse("2026-09-10T02:14:00+09:00"),
    checkInAt: null,
    checkOutAt: null,
    isStayover: false,
    nightsTotal: 1,
    nightIndex: 1,
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
      number: "208",
      roomTypeId: "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
      saleStatus: "ON_SALE",
    },
    // **既定が「稼働記録なし」。** これが R006 の見ている状態。
    occupancy: null,
    observation: observation(),
    task: task(),
    signals: [],
    accessLogs: [],
    baselines: [],
    previousObservation: null,
    thresholds: {},
    ...overrides,
  };
}

describe("R006 — 正例（差異を返す）", () => {
  it("① 連携のある施設で、稼働記録が無い日に清掃が完了している", () => {
    const draft = R006.evaluate(context());
    expect(draft?.ruleCode).toBe("R006");
    expect(draft?.severity).toBe("MEDIUM");
    expect(draft?.confidence).toBe(R006_CONFIDENCE);
  });

  it("② 根拠は 2 つ（記録の欠落と清掃の完了）", () => {
    expect(R006.evaluate(context())?.matchedSignals).toEqual([
      "OCCUPANCY_MISSING",
      "CLEANING_COMPLETED",
    ]);
  });

  it("③ 観察をスキップした清掃でも該当する（記録しないのは正当な操作）", () => {
    expect(R006.evaluate(context({ observation: observation({ skipped: true }) }))).not.toBeNull();
  });

  it("④ 痕跡の有無に関係なく該当する（見ているのは連携）", () => {
    const used = R006.evaluate(context({ observation: observation({ bedsUsed: 2 }) }));
    const clean = R006.evaluate(context({ observation: observation({ bedsUsed: 0 }) }));
    expect(used?.confidence).toBe(clean?.confidence);
  });

  it("⑤ 欠けている系統を null として渡す（§6.2 の「データなし」）", () => {
    const draft = R006.evaluate(context());
    expect(draft?.evidence["occupancy"]).toBeNull();
    expect(draft?.evidence["task"]).toMatchObject({ completedAt: COMPLETED_AT });
  });

  it("⑥ 部屋番号を表題に出し、原因を断定しない文言にする（§1.1）", () => {
    const draft = R006.evaluate(context());
    expect(draft?.title).toBe("208 号室：稼働記録なしの清掃発生");
    expect(draft?.summary).toContain("可能性");
  });
});

describe("R006 — 負例（差異を返さない）", () => {
  it("① 稼働記録がある日は該当しない（空室の記録でも R001 の担当）", () => {
    expect(R006.evaluate(context({ occupancy: occupancy() }))).toBeNull();
    expect(R006.evaluate(context({ occupancy: occupancy({ isOccupied: false }) }))).toBeNull();
  });

  it("② 連携を持たない施設では該当しない（記録が無いのが正常）", () => {
    const base = context();
    expect(
      R006.evaluate(context({ property: { ...base.property, occupancyLinked: false } })),
    ).toBeNull();
  });

  it("③ 清掃が完了していなければ該当しない", () => {
    expect(R006.evaluate(context({ task: task({ isCompleted: false }) }))).toBeNull();
  });

  it("④ 清掃タスクそのものが無ければ該当しない", () => {
    expect(R006.evaluate(context({ task: null }))).toBeNull();
  });

  it("⑤ 販売していない客室は評価に入らない（§4.1 / evaluate() が抑制する）", () => {
    const base = context();
    const result = evaluate(
      context({ room: { ...base.room, saleStatus: "MAINTENANCE" } }),
      {},
      [R006],
    );
    expect(result.findings).toEqual([]);
    expect(result.suppressed).toEqual([{ ruleCode: "R006", reason: "ROOM_NOT_ON_SALE" }]);
  });

  it("⑥ 観察系統が無い日は評価に入らない（§1.2 / 必要系統は B）", () => {
    const result = evaluate(context({ observation: null }), {}, [R006]);
    expect(result.findings).toEqual([]);
    expect(result.suppressed).toEqual([{ ruleCode: "R006", reason: "SOURCE_UNAVAILABLE" }]);
  });

  it("⑦ 設定で無効にすれば評価に入らない（§4.1）", () => {
    const result = evaluate(
      context(),
      { settings: { R006: { isEnabled: false, severityOverride: null, thresholds: {} } } },
      [R006],
    );
    expect(result.suppressed).toEqual([{ ruleCode: "R006", reason: "RULE_DISABLED" }]);
  });
});

describe("R006 — evaluate() 経由の調整", () => {
  it("根拠が 2 つあるので単一シグナルの上限に当たらない", () => {
    const finding = evaluate(context(), {}, [R006]).findings[0];
    expect(finding?.matchedSignals).toHaveLength(2);
    expect(finding?.confidence).toBe(R006_CONFIDENCE);
  });

  it("運用が浅い施設では確信度が 10 下がる（§4.2）", () => {
    const base = context();
    const finding = evaluate(
      context({ property: { ...base.property, daysSinceOperationStart: 30 } }),
      {},
      [R006],
    ).findings[0];
    expect(finding?.confidence).toBe(R006_CONFIDENCE - 10);
  });

  it("同じ入力を 3 回評価しても同じ結果（§10.1）", () => {
    const runs = [1, 2, 3].map(() => evaluate(context(), {}, [R006]));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});
