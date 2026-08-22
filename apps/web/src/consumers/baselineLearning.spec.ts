/**
 * ベースライン週次バッチのテスト（PK-SPEC-P3 §5）。
 *
 * task:  docs/tasks/P3-09.md
 * ルール: .claude/rules/testing.md §4（冪等: 3 回実行しても結果が変わらない）
 *
 * ── 何をテストしているか ────────────────────────────────
 * `recomputeBaseline()` を丸ごと動かすには、D1 の代役へ
 * 「観察 → タスク → リネン → 稼働予定」を 6 区間ぶん実行順どおりに
 * 積むことになる。順序に依存したテストは実装の読み取り順を変えただけで
 * 壊れる（`dailyReport.spec.ts` と同じ判断）。
 *
 * そこで冪等性は**結果が決まる 3 か所**で押さえる。
 *   ① 集計ウィンドウ … `computedTo` と日数から決まる（`window.spec.ts`）
 *   ② 統計量 … 同じ観察集合から同じ値（`packages/engine`）
 *   ③ メッセージの検証 … 壊れたメッセージを ack して落とす
 * ①②が揃えば「同じメッセージを 3 回処理しても DB の状態が同じ」が
 * 成り立つ（書き込みは upsert と施設単位の置き換え）。
 */

import { computeBaseline, toObservationSamples, type ObservationSample } from "@pk/engine";
import { describe, expect, it } from "vitest";

import { baselineWindowOf } from "../lib/baseline/window.js";

import { isBaselineLearningMessage, type BaselineLearningMessage } from "./baselineLearning.js";

const MESSAGE: BaselineLearningMessage = {
  kind: "BASELINE_LEARNING",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  propertyId: "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6",
  computedTo: "2026-09-12",
  windowDays: 90,
  mode: "AUTO",
  requestedById: null,
  requestedAtMs: Date.UTC(2026, 8, 12, 18, 0, 0),
};

describe("isBaselineLearningMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isBaselineLearningMessage(MESSAGE)).toBe(true);
  });

  it("手動再計算（`MANUAL` + 依頼者）も受け入れる", () => {
    expect(
      isBaselineLearningMessage({
        ...MESSAGE,
        mode: "MANUAL",
        requestedById: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR6",
      }),
    ).toBe(true);
  });

  it("kind が違えば拒む", () => {
    expect(isBaselineLearningMessage({ ...MESSAGE, kind: "DAILY_REPORT" })).toBe(false);
  });

  it("欠けた欄があれば拒む", () => {
    const rest: Record<string, unknown> = { ...MESSAGE };
    delete rest["computedTo"];
    expect(isBaselineLearningMessage(rest)).toBe(false);
  });

  it("mode が語彙の外なら拒む", () => {
    expect(isBaselineLearningMessage({ ...MESSAGE, mode: "AUTOMATIC" })).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isBaselineLearningMessage(null)).toBe(false);
    expect(isBaselineLearningMessage("BASELINE_LEARNING")).toBe(false);
  });
});

describe("冪等（testing.md §4）", () => {
  it("同じメッセージからは同じウィンドウが決まる", () => {
    const first = baselineWindowOf(MESSAGE.computedTo, MESSAGE.windowDays);
    const second = baselineWindowOf(MESSAGE.computedTo, MESSAGE.windowDays);
    const third = baselineWindowOf(MESSAGE.computedTo, MESSAGE.windowDays);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("同じ観察集合を 3 回計算しても統計量が変わらない", () => {
    const samples = samplesOf();
    const window = baselineWindowOf(MESSAGE.computedTo, MESSAGE.windowDays);
    const runs = [0, 1, 2].map(() => computeBaseline(samples, { window }));
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[1]).toEqual(runs[2]);
  });

  it("読み込みの順序が変わっても統計量が変わらない", () => {
    const window = baselineWindowOf(MESSAGE.computedTo, MESSAGE.windowDays);
    const forward = computeBaseline(samplesOf(), { window });
    const reversed = computeBaseline([...samplesOf()].reverse(), { window });
    expect(forward).toEqual(reversed);
  });

  it("ウィンドウの外の観察は集計に入らない", () => {
    const window = baselineWindowOf(MESSAGE.computedTo, MESSAGE.windowDays);
    const outside = samplesOf().map((sample) => ({ ...sample, businessDate: "2026-01-01" }));
    expect(computeBaseline(outside, { window }).baselines).toEqual([]);
  });
});

describe("平坦化から統計量まで（§5.2）", () => {
  it("観察 1 件・品目 5 つが 5 行のベースラインになる", () => {
    const flattened = toObservationSamples({
      observations: [
        {
          observationId: "obs_1",
          propertyId: MESSAGE.propertyId,
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
        cupsUsed: 2,
        extraFutonUsed: 0,
          amenitiesUsed: {},
          inputDurationMs: 12_000,
          recordedById: "mem_1",
        },
      ],
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
      itemCodes: ["BATH_TOWEL", "FACE_TOWEL", "HAND_TOWEL", "BATH_MAT", "SLIPPERS"],
    });

    const computed = computeBaseline(flattened.samples, {
      window: baselineWindowOf(MESSAGE.computedTo, MESSAGE.windowDays),
    });
    expect(computed.baselines).toHaveLength(5);
    // サンプル 1 件では信頼できない（§2.4 MUST）。
    expect(computed.baselines.every((baseline) => !baseline.isReliable)).toBe(true);
  });
});

/** 同じ組み合わせの観察を 25 件（`isReliable` の閾値 20 を超える）。 */
function samplesOf(): ObservationSample[] {
  return Array.from({ length: 25 }, (_unused, index) => ({
    observationId: `obs_${String(index)}`,
    propertyId: MESSAGE.propertyId,
    roomTypeId: "twin",
    guestCount: 2,
    taskType: "CHECKOUT",
    itemCode: "BATH_TOWEL",
    qty: index % 3,
    businessDate: "2026-09-10",
    recordedById: `mem_${String(index)}`,
    bedsUsed: 2,
    inputDurationMs: 12_000,
    hasFinding: false,
    observationSkipped: false,
  }));
}
