/**
 * 入力品質のテスト（PK-SPEC-P3 §6.3）。
 *
 * task:  docs/tasks/P3-12.md
 * ルール: .claude/rules/testing.md §3 / security.md §5
 *
 * 見るのは 4 つ。
 *   ① 5 指標の分子・分母（率は千分率、母数 0 は `null`）
 *   ② 目標・警告の判定の向き（下回ると警告 / 上回ると警告）
 *   ③ スタッフ別は 20 タスク未満で `display: false`
 *   ④ 成熟度は「全品目が信頼可能」で組み合わせが信頼可能
 */

import { describe, expect, it } from "vitest";

import {
  DATA_QUALITY_THRESHOLDS,
  MINIMUM_TASKS_FOR_STAFF_RATE,
  computeDataQuality,
  dataQualityStatuses,
  type DataQualityInput,
} from "./dataQuality.js";

function tasksOf(
  count: number,
  overrides: (index: number) => Partial<DataQualityInput["tasks"][number]> = () => ({}),
): DataQualityInput["tasks"] {
  return Array.from({ length: count }, (_unused, index) => ({
    taskId: `task_${String(index)}`,
    hasObservation: true,
    observationSkipped: false,
    assigneeId: null,
    ...overrides(index),
  }));
}

function inputOf(overrides: Partial<DataQualityInput> = {}): DataQualityInput {
  return {
    tasks: tasksOf(10),
    observations: Array.from({ length: 10 }, (_unused, index) => ({
      observationId: `obs_${String(index)}`,
      usedDefaults: false,
      inputDurationMs: 12_000,
    })),
    excludedObservationIds: [],
    baselines: [],
    ...overrides,
  };
}

describe("computeDataQuality — 5 指標", () => {
  it("入力率は観察のあるタスク / 対象タスク", () => {
    const quality = computeDataQuality(
      inputOf({ tasks: tasksOf(10, (index) => ({ hasObservation: index < 9 })) }),
    );
    expect(quality.inputRate).toEqual({ numerator: 9, denominator: 10, permille: 900 });
  });

  it("既定値率は `usedDefaults` / 観察記録", () => {
    const quality = computeDataQuality(
      inputOf({
        observations: Array.from({ length: 4 }, (_unused, index) => ({
          observationId: `obs_${String(index)}`,
          usedDefaults: index < 3,
          inputDurationMs: null,
        })),
      }),
    );
    expect(quality.defaultRate.permille).toBe(750);
  });

  it("平均入力時間は計測できたものだけの平均", () => {
    const quality = computeDataQuality(
      inputOf({
        observations: [
          { observationId: "obs_0", usedDefaults: false, inputDurationMs: 10_000 },
          { observationId: "obs_1", usedDefaults: false, inputDurationMs: 20_000 },
          { observationId: "obs_2", usedDefaults: false, inputDurationMs: null },
        ],
      }),
    );
    expect(quality.inputDuration).toEqual({ count: 2, averageMs: 15_000 });
  });

  it("外れ値除外率は「いずれかの品目で除外された観察」の数で数える", () => {
    // 同じ観察が 3 品目で除外されても 1 件。
    const quality = computeDataQuality(
      inputOf({ excludedObservationIds: ["obs_0", "obs_0", "obs_0", "obs_1"] }),
    );
    expect(quality.exclusionRate).toEqual({ numerator: 2, denominator: 10, permille: 200 });
  });

  it("未記録率は「今回は記録しない」/ 対象タスク", () => {
    const quality = computeDataQuality(
      inputOf({
        tasks: tasksOf(10, (index) => ({
          hasObservation: index >= 2,
          observationSkipped: index < 2,
        })),
      }),
    );
    expect(quality.skipRate.permille).toBe(200);
  });

  it("入力率 + 未記録率は 100% にならないことがある", () => {
    // 記録もスキップもされないまま終わったタスクがある。
    const quality = computeDataQuality(
      inputOf({
        tasks: tasksOf(10, (index) => ({
          hasObservation: index < 5,
          observationSkipped: index >= 8,
        })),
      }),
    );
    expect((quality.inputRate.permille ?? 0) + (quality.skipRate.permille ?? 0)).toBe(700);
  });

  it("母数が 0 の率は `null`（0% と区別する）", () => {
    const quality = computeDataQuality(inputOf({ tasks: [], observations: [] }));
    expect(quality.inputRate.permille).toBeNull();
    expect(quality.defaultRate.permille).toBeNull();
    expect(quality.inputDuration.averageMs).toBeNull();
  });

  it("除外 ID がその期間の観察に無ければ数えない", () => {
    const quality = computeDataQuality(inputOf({ excludedObservationIds: ["obs_999"] }));
    expect(quality.exclusionRate.numerator).toBe(0);
  });
});

describe("dataQualityStatuses — 判定の向き", () => {
  it("入力率は目標を下回ると警告", () => {
    const low = computeDataQuality(
      inputOf({ tasks: tasksOf(10, (index) => ({ hasObservation: index < 9 })) }),
    );
    expect(dataQualityStatuses(low)["inputRate"]).toBe("WARN");
    expect(DATA_QUALITY_THRESHOLDS.inputRateTargetPermille).toBe(950);
  });

  it("入力率が目標ちょうどなら警告しない", () => {
    const exact = computeDataQuality(
      inputOf({
        tasks: tasksOf(20, (index) => ({ hasObservation: index < 19 })),
      }),
    );
    expect(exact.inputRate.permille).toBe(950);
    expect(dataQualityStatuses(exact)["inputRate"]).toBe("OK");
  });

  it("既定値率は閾値を上回ると警告", () => {
    const high = computeDataQuality(
      inputOf({
        observations: Array.from({ length: 10 }, (_unused, index) => ({
          observationId: `obs_${String(index)}`,
          usedDefaults: index < 10,
          inputDurationMs: null,
        })),
      }),
    );
    expect(dataQualityStatuses(high)["defaultRate"]).toBe("WARN");
  });

  it("平均入力時間は 20 秒を超えると警告", () => {
    const slow = computeDataQuality(
      inputOf({
        observations: [{ observationId: "obs_0", usedDefaults: false, inputDurationMs: 25_000 }],
      }),
    );
    expect(dataQualityStatuses(slow)["inputDuration"]).toBe("WARN");
  });

  it("外れ値除外率は 15% を超えると警告", () => {
    const noisy = computeDataQuality(
      inputOf({ excludedObservationIds: ["obs_0", "obs_1"] }),
    );
    expect(dataQualityStatuses(noisy)["exclusionRate"]).toBe("WARN");
  });

  it("未記録率は 20% を超えると警告", () => {
    const skipped = computeDataQuality(
      inputOf({
        tasks: tasksOf(10, (index) => ({
          hasObservation: index >= 3,
          observationSkipped: index < 3,
        })),
      }),
    );
    expect(dataQualityStatuses(skipped)["skipRate"]).toBe("WARN");
  });

  it("母数が無ければ UNKNOWN（警告にしない）", () => {
    const empty = computeDataQuality(inputOf({ tasks: [], observations: [] }));
    const statuses = dataQualityStatuses(empty);
    expect(statuses["inputRate"]).toBe("UNKNOWN");
    expect(statuses["inputDuration"]).toBe("UNKNOWN");
  });
});

describe("スタッフ別の入力率（security.md §5）", () => {
  it("20 タスク以上なら表示してよい", () => {
    const quality = computeDataQuality(
      inputOf({
        tasks: tasksOf(MINIMUM_TASKS_FOR_STAFF_RATE, () => ({ assigneeId: "mem_a" })),
      }),
    );
    expect(quality.staffInputRates[0]?.display).toBe(true);
  });

  it("20 タスク未満は `display: false`", () => {
    const quality = computeDataQuality(
      inputOf({
        tasks: tasksOf(MINIMUM_TASKS_FOR_STAFF_RATE - 1, () => ({ assigneeId: "mem_a" })),
      }),
    );
    expect(quality.staffInputRates[0]?.display).toBe(false);
    // **母数は返す**（画面が「20 件未満」と出せるように）。
    expect(quality.staffInputRates[0]?.rate.denominator).toBe(19);
  });

  it("未割当のタスクは誰の分母にも入らない", () => {
    const quality = computeDataQuality(inputOf({ tasks: tasksOf(10) }));
    expect(quality.staffInputRates).toEqual([]);
  });

  it("並びは ID の昇順（順位を持たせない）", () => {
    const quality = computeDataQuality(
      inputOf({
        tasks: tasksOf(4, (index) => ({ assigneeId: index % 2 === 0 ? "mem_b" : "mem_a" })),
      }),
    );
    expect(quality.staffInputRates.map((staff) => staff.assigneeId)).toEqual(["mem_a", "mem_b"]);
  });

  it("所要時間・既定値率をスタッフ別に持たない", () => {
    const quality = computeDataQuality(
      inputOf({ tasks: tasksOf(20, () => ({ assigneeId: "mem_a" })) }),
    );
    const [staff] = quality.staffInputRates;
    expect(Object.keys(staff ?? {}).sort()).toEqual(["assigneeId", "display", "rate"]);
  });
});

describe("ベースラインの成熟度", () => {
  it("全品目が信頼可能なら組み合わせも信頼可能", () => {
    const quality = computeDataQuality(
      inputOf({
        baselines: [
          { roomTypeId: "twin", guestCount: 2, isReliable: true },
          { roomTypeId: "twin", guestCount: 2, isReliable: true },
        ],
      }),
    );
    expect(quality.maturity.reliableCount).toBe(1);
    expect(quality.maturity.totalCount).toBe(1);
  });

  it("1 品目でも信頼できなければ組み合わせは未成熟", () => {
    const quality = computeDataQuality(
      inputOf({
        baselines: [
          { roomTypeId: "twin", guestCount: 3, isReliable: true },
          { roomTypeId: "twin", guestCount: 3, isReliable: false },
        ],
      }),
    );
    expect(quality.maturity.combinations[0]?.isReliable).toBe(false);
    expect(quality.maturity.combinations[0]?.reliableItemCount).toBe(1);
    expect(quality.maturity.combinations[0]?.itemCount).toBe(2);
  });

  it("客室タイプ × 人数で分かれる", () => {
    const quality = computeDataQuality(
      inputOf({
        baselines: [
          { roomTypeId: "twin", guestCount: 2, isReliable: true },
          { roomTypeId: "twin", guestCount: 3, isReliable: false },
          { roomTypeId: "japanese", guestCount: 4, isReliable: false },
        ],
      }),
    );
    expect(quality.maturity.totalCount).toBe(3);
    expect(quality.maturity.reliableCount).toBe(1);
  });

  it("並びは客室タイプ・人数の昇順（入力順に依存しない）", () => {
    const quality = computeDataQuality(
      inputOf({
        baselines: [
          { roomTypeId: "twin", guestCount: 3, isReliable: true },
          { roomTypeId: "japanese", guestCount: 4, isReliable: true },
          { roomTypeId: "twin", guestCount: 2, isReliable: true },
        ],
      }),
    );
    expect(
      quality.maturity.combinations.map(
        (combination) => `${combination.roomTypeId}|${String(combination.guestCount)}`,
      ),
    ).toEqual(["japanese|4", "twin|2", "twin|3"]);
  });

  it("ベースラインが無ければ 0 / 0", () => {
    const quality = computeDataQuality(inputOf());
    expect(quality.maturity).toEqual({ combinations: [], reliableCount: 0, totalCount: 0 });
  });
});
