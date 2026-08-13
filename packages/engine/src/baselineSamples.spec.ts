/**
 * 観察記録の平坦化のテスト（PK-SPEC-P3 §5.2）。
 *
 * task:  docs/tasks/P3-09.md
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * 見るのは 4 つ。
 *   ① 経路の優先順位（列 > JSON > リネン）で 1 タスク 1 品目 1 件になる
 *   ② 語彙に無い品目コードを捨てる
 *   ③ タスク・稼働予定の無い観察を捨て、件数を返す
 *   ④ 入力の順序に依存しない（決定性 / §9.3）
 */

import { describe, expect, it } from "vitest";

import { computeBaseline } from "./baseline.js";
import {
  toObservationSamples,
  type BaselineObservationInput,
  type BaselineSampleInput,
} from "./baselineSamples.js";

const ITEM_CODES = [
  "SHEET_SINGLE",
  "BATH_TOWEL",
  "FACE_TOWEL",
  "HAND_TOWEL",
  "BATH_MAT",
  "SLIPPERS",
  "TOOTHBRUSH",
  "BOTTLED_WATER",
] as const;

function observationOf(
  overrides: Partial<BaselineObservationInput> = {},
): BaselineObservationInput {
  return {
    observationId: "obs_1",
    propertyId: "prop_1",
    taskId: "task_1",
    roomId: "room_1",
    roomTypeId: "twin",
    businessDate: "2026-09-10",
    bedsUsed: 2,
    bathTowelUsed: 2,
    faceTowelUsed: 2,
    handTowelUsed: 1,
    bathMatUsed: 1,
    slippersUsed: 2,
    amenitiesUsed: {},
    inputDurationMs: 12_000,
    recordedById: "mem_1",
    ...overrides,
  };
}

function inputOf(overrides: Partial<BaselineSampleInput> = {}): BaselineSampleInput {
  return {
    observations: [observationOf()],
    tasks: [
      {
        taskId: "task_1",
        roomId: "room_1",
        businessDate: "2026-09-10",
        taskType: "CHECKOUT",
        observationSkipped: false,
      },
    ],
    linenRecords: [],
    roomPlans: [{ roomId: "room_1", businessDate: "2026-09-10", guestCount: 2 }],
    itemCodes: ITEM_CODES,
    ...overrides,
  };
}

describe("toObservationSamples — 採るもの", () => {
  it("列を持つ 5 品目がサンプルになる", () => {
    const result = toObservationSamples(inputOf());
    expect(result.samples.map((sample) => sample.itemCode).sort()).toEqual([
      "BATH_MAT",
      "BATH_TOWEL",
      "FACE_TOWEL",
      "HAND_TOWEL",
      "SLIPPERS",
    ]);
  });

  it("集計キーはタスクと稼働予定から解決される", () => {
    const [sample] = toObservationSamples(inputOf()).samples;
    expect(sample?.taskType).toBe("CHECKOUT");
    expect(sample?.guestCount).toBe(2);
    expect(sample?.roomTypeId).toBe("twin");
  });

  it("アメニティの JSON も品目になる（数はそのまま）", () => {
    const result = toObservationSamples(
      inputOf({
        observations: [observationOf({ amenitiesUsed: { TOOTHBRUSH: 2 } })],
      }),
    );
    expect(result.samples.find((sample) => sample.itemCode === "TOOTHBRUSH")?.qty).toBe(2);
  });

  it("アメニティの真偽値は 1 / 0 に寄せる", () => {
    const result = toObservationSamples(
      inputOf({
        observations: [
          observationOf({ amenitiesUsed: { TOOTHBRUSH: true, BOTTLED_WATER: false } }),
        ],
      }),
    );
    expect(result.samples.find((sample) => sample.itemCode === "TOOTHBRUSH")?.qty).toBe(1);
    expect(result.samples.find((sample) => sample.itemCode === "BOTTLED_WATER")?.qty).toBe(0);
  });

  it("列を持たない品目はリネン記録から拾う", () => {
    const result = toObservationSamples(
      inputOf({
        linenRecords: [{ taskId: "task_1", itemCode: "SHEET_SINGLE", collectedQty: 2 }],
      }),
    );
    expect(result.samples.find((sample) => sample.itemCode === "SHEET_SINGLE")?.qty).toBe(2);
  });

  it("`observationSkipped` はタスク側の値を運ぶ（除外は computeBaseline の仕事）", () => {
    const result = toObservationSamples(
      inputOf({
        tasks: [
          {
            taskId: "task_1",
            roomId: "room_1",
            businessDate: "2026-09-10",
            taskType: "CHECKOUT",
            observationSkipped: true,
          },
        ],
      }),
    );
    expect(result.samples.every((sample) => sample.observationSkipped)).toBe(true);
  });
});

describe("toObservationSamples — 採らないもの", () => {
  it("同じ品目が列とリネンの両方にあっても 1 件（列が勝つ）", () => {
    const result = toObservationSamples(
      inputOf({
        linenRecords: [{ taskId: "task_1", itemCode: "BATH_TOWEL", collectedQty: 9 }],
      }),
    );
    const towels = result.samples.filter((sample) => sample.itemCode === "BATH_TOWEL");
    expect(towels).toHaveLength(1);
    expect(towels[0]?.qty).toBe(2);
  });

  it("同じ品目が JSON とリネンの両方にあっても 1 件（JSON が勝つ）", () => {
    const result = toObservationSamples(
      inputOf({
        observations: [observationOf({ amenitiesUsed: { SHEET_SINGLE: 1 } })],
        linenRecords: [{ taskId: "task_1", itemCode: "SHEET_SINGLE", collectedQty: 9 }],
      }),
    );
    const sheets = result.samples.filter((sample) => sample.itemCode === "SHEET_SINGLE");
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.qty).toBe(1);
  });

  it("語彙に無い品目コードは捨てる", () => {
    const result = toObservationSamples(
      inputOf({
        observations: [observationOf({ amenitiesUsed: { UNKNOWN_ITEM: 3 } })],
        linenRecords: [{ taskId: "task_1", itemCode: "ALSO_UNKNOWN", collectedQty: 1 }],
      }),
    );
    expect(result.samples.map((sample) => sample.itemCode)).not.toContain("UNKNOWN_ITEM");
    expect(result.samples.map((sample) => sample.itemCode)).not.toContain("ALSO_UNKNOWN");
  });

  it("タスクが無い観察は捨てて件数を返す", () => {
    const result = toObservationSamples(inputOf({ tasks: [] }));
    expect(result.samples).toHaveLength(0);
    expect(result.droppedNoTask).toBe(1);
  });

  it("稼働予定（人数）が無い観察は捨てて件数を返す", () => {
    const result = toObservationSamples(inputOf({ roomPlans: [] }));
    expect(result.samples).toHaveLength(0);
    expect(result.droppedNoRoomPlan).toBe(1);
  });

  it("業務日の違う稼働予定は人数として使わない", () => {
    const result = toObservationSamples(
      inputOf({ roomPlans: [{ roomId: "room_1", businessDate: "2026-09-09", guestCount: 2 }] }),
    );
    expect(result.droppedNoRoomPlan).toBe(1);
  });

  it("数でも真偽値でもない JSON の値は捨てる", () => {
    const result = toObservationSamples(
      inputOf({
        observations: [
          observationOf({ amenitiesUsed: { TOOTHBRUSH: Number.NaN } }),
        ],
      }),
    );
    expect(result.samples.map((sample) => sample.itemCode)).not.toContain("TOOTHBRUSH");
  });
});

describe("toObservationSamples — 決定性（§9.3）", () => {
  it("リネン記録の並び順を変えても同じ統計量になる", () => {
    const linen = [
      { taskId: "task_1", itemCode: "SHEET_SINGLE", collectedQty: 2 },
      { taskId: "task_2", itemCode: "SHEET_SINGLE", collectedQty: 3 },
    ];
    const base = inputOf({
      observations: [observationOf(), observationOf({ observationId: "obs_2", taskId: "task_2" })],
      tasks: [
        {
          taskId: "task_1",
          roomId: "room_1",
          businessDate: "2026-09-10",
          taskType: "CHECKOUT",
          observationSkipped: false,
        },
        {
          taskId: "task_2",
          roomId: "room_1",
          businessDate: "2026-09-10",
          taskType: "CHECKOUT",
          observationSkipped: false,
        },
      ],
      linenRecords: linen,
    });
    const reversed = { ...base, linenRecords: [...linen].reverse() };

    expect(computeBaseline(toObservationSamples(base).samples)).toEqual(
      computeBaseline(toObservationSamples(reversed).samples),
    );
  });

  it("JSON のキー順を変えても同じサンプルになる", () => {
    const a = toObservationSamples(
      inputOf({
        observations: [observationOf({ amenitiesUsed: { TOOTHBRUSH: 2, BOTTLED_WATER: 1 } })],
      }),
    );
    const b = toObservationSamples(
      inputOf({
        observations: [observationOf({ amenitiesUsed: { BOTTLED_WATER: 1, TOOTHBRUSH: 2 } })],
      }),
    );
    expect(a.samples).toEqual(b.samples);
  });
});
