/**
 * 施設向け指標（P2-15 / PK-SPEC-P2 §10）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *         .claude/rules/security.md §5 / PK-IMPL-CONTRACT INV-01〜03
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PROPERTY_METRIC_KEYS,
  computePropertyMetrics,
  metricAverage,
  metricRate,
  type PropertyMetricsInput,
  type PropertyMetricsInspectionInput,
  type PropertyMetricsTaskInput,
} from "./metrics.js";

const BASE = Date.parse("2026-09-10T05:00:00.000Z");

/** 分をミリ秒に直す。 */
function minutes(value: number): number {
  return value * 60_000;
}

function task(
  taskId: string,
  overrides: Partial<PropertyMetricsTaskInput> = {},
): PropertyMetricsTaskInput {
  return {
    taskId,
    taskType: "CHECKOUT",
    roomTypeId: "rt_twin",
    status: "COMPLETED",
    completedAtMs: BASE,
    actualMinutes: 30,
    ...overrides,
  };
}

function inspection(
  taskId: string,
  overrides: Partial<PropertyMetricsInspectionInput> = {},
): PropertyMetricsInspectionInput {
  return {
    taskId,
    round: 1,
    result: "PASS",
    startedAtMs: BASE + minutes(5),
    selfApproved: false,
    ...overrides,
  };
}

function build(overrides: Partial<PropertyMetricsInput> = {}): PropertyMetricsInput {
  return {
    periodFrom: "2026-09-01",
    periodTo: "2026-09-30",
    slaMinutes: 20,
    tasks: [],
    inspections: [],
    reworks: [],
    ...overrides,
  };
}

describe("metricRate", () => {
  // ── 正例 ────────────────────────────────────────────────
  it("分子と分母をそのまま持つ", () => {
    expect(metricRate(44, 50)).toEqual({ numerator: 44, denominator: 50, permille: 880 });
  });

  it("千分率は 0.1pt 刻みの百分率と同じ精度（91.4% → 914）", () => {
    expect(metricRate(914, 1000).permille).toBe(914);
  });

  it("割り切れない率を四捨五入する（2/3 = 66.7%）", () => {
    expect(metricRate(2, 3).permille).toBe(667);
  });

  it("全件なら 1000", () => {
    expect(metricRate(7, 7).permille).toBe(1000);
  });

  it("0 件なら 0（分母があるので null ではない）", () => {
    expect(metricRate(0, 12).permille).toBe(0);
  });

  // ── 負例 ────────────────────────────────────────────────
  it("分母 0 は null。0% と区別する", () => {
    expect(metricRate(0, 0).permille).toBeNull();
  });

  it("分子が負なら RangeError", () => {
    expect(() => metricRate(-1, 10)).toThrow(RangeError);
  });

  it("分母が負なら RangeError", () => {
    expect(() => metricRate(1, -10)).toThrow(RangeError);
  });

  it("分子が小数なら RangeError", () => {
    expect(() => metricRate(1.5, 10)).toThrow(RangeError);
  });

  it("分母が NaN なら RangeError", () => {
    expect(() => metricRate(1, Number.NaN)).toThrow(RangeError);
  });
});

describe("metricAverage", () => {
  // ── 正例 ────────────────────────────────────────────────
  it("平均を四捨五入した整数で返す", () => {
    expect(metricAverage([20, 30, 40])).toEqual({ count: 3, minutes: 30 });
  });

  it("端数は四捨五入（26.33 → 26）", () => {
    expect(metricAverage([26, 26, 27])).toEqual({ count: 3, minutes: 26 });
  });

  it("0.5 は上へ寄る（決定性）", () => {
    expect(metricAverage([26, 27]).minutes).toBe(27);
  });

  it("1 件でも平均を出す", () => {
    expect(metricAverage([45])).toEqual({ count: 1, minutes: 45 });
  });

  it("すべて 0 分なら 0 分（null ではない）", () => {
    expect(metricAverage([0, 0])).toEqual({ count: 2, minutes: 0 });
  });

  // ── 負例 ────────────────────────────────────────────────
  it("空なら null。0 分と区別する", () => {
    expect(metricAverage([])).toEqual({ count: 0, minutes: null });
  });
});

describe("computePropertyMetrics — ① 完了率", () => {
  // ── 正例 ────────────────────────────────────────────────
  it("COMPLETED / 対象タスク", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [
          task("a"),
          task("b"),
          task("c", { status: "AWAITING_INSPECTION" }),
          task("d", { status: "IN_PROGRESS" }),
        ],
      }),
    );
    expect(metrics.completionRate).toEqual({ numerator: 2, denominator: 4, permille: 500 });
  });

  it("全件完了なら 1000", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a"), task("b")] }));
    expect(metrics.completionRate.permille).toBe(1000);
  });

  it("BLOCKED は分母に残る（作業は対象のまま）", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a"), task("b", { status: "BLOCKED" })] }),
    );
    expect(metrics.completionRate).toEqual({ numerator: 1, denominator: 2, permille: 500 });
  });

  it("REWORK も分母に残る", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a"), task("b", { status: "REWORK" })] }),
    );
    expect(metrics.completionRate.denominator).toBe(2);
  });

  it("targetTasks が分母と一致する", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a"), task("b")] }));
    expect(metrics.targetTasks).toBe(metrics.completionRate.denominator);
  });

  // ── 負例 ────────────────────────────────────────────────
  it("CANCELLED を分母から外す（DECISIONS #088）", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a"), task("b", { status: "CANCELLED" })] }),
    );
    expect(metrics.completionRate).toEqual({ numerator: 1, denominator: 1, permille: 1000 });
  });

  it("すべて CANCELLED なら分母 0 で null", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a", { status: "CANCELLED" })] }));
    expect(metrics.completionRate.permille).toBeNull();
  });

  it("タスクが 1 件も無ければ null", () => {
    expect(computePropertyMetrics(build()).completionRate.permille).toBeNull();
  });

  it("1 件も完了していなければ 0", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a", { status: "IN_PROGRESS" })] }),
    );
    expect(metrics.completionRate.permille).toBe(0);
  });

  it("CANCELLED は completedTasks にも入らない", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a", { status: "CANCELLED" })] }));
    expect(metrics.completionRate.numerator).toBe(0);
  });
});

describe("computePropertyMetrics — ②③⑦ 検査対象を分母にする率", () => {
  // ── 正例 ────────────────────────────────────────────────
  it("初回検査合格率 = Round 1 PASS / 検査対象", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a"), task("b"), task("c"), task("d")],
        inspections: [
          inspection("a"),
          inspection("b"),
          inspection("c", { result: "FAIL" }),
          inspection("d", { result: "FAIL" }),
        ],
      }),
    );
    expect(metrics.firstPassRate).toEqual({ numerator: 2, denominator: 4, permille: 500 });
  });

  it("Round 2 で合格しても初回合格には数えない", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a")],
        inspections: [
          inspection("a", { round: 2, result: "PASS", startedAtMs: BASE + minutes(30) }),
          inspection("a", { round: 1, result: "FAIL" }),
        ],
        reworks: [{ taskId: "a" }],
      }),
    );
    expect(metrics.firstPassRate.numerator).toBe(0);
  });

  it("再清掃率 = 差戻しが 1 回以上 / 検査対象", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a"), task("b"), task("c"), task("d")],
        inspections: [inspection("a"), inspection("b"), inspection("c"), inspection("d")],
        reworks: [{ taskId: "a" }],
      }),
    );
    expect(metrics.reworkRate).toEqual({ numerator: 1, denominator: 4, permille: 250 });
  });

  it("同じタスクの差戻しが 2 回でも 1 件として数える", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a"), task("b")],
        inspections: [inspection("a"), inspection("b")],
        reworks: [{ taskId: "a" }, { taskId: "a" }],
      }),
    );
    expect(metrics.reworkRate.numerator).toBe(1);
  });

  it("自己検査率 = selfApproved / 検査対象", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a"), task("b")],
        inspections: [inspection("a", { selfApproved: true }), inspection("b")],
      }),
    );
    expect(metrics.selfInspectionRate).toEqual({ numerator: 1, denominator: 2, permille: 500 });
  });

  it("Round 2 だけが自己検査でも数える", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a")],
        inspections: [
          inspection("a", { result: "FAIL" }),
          inspection("a", { round: 2, selfApproved: true, startedAtMs: BASE + minutes(30) }),
        ],
      }),
    );
    expect(metrics.selfInspectionRate.numerator).toBe(1);
  });

  // ── 負例 ────────────────────────────────────────────────
  it("検査の記録が無いタスクは分母に入らない（設定で数えない）", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a"), task("b")], inspections: [inspection("a")] }),
    );
    expect(metrics.inspectedTasks).toBe(1);
    expect(metrics.firstPassRate.denominator).toBe(1);
  });

  it("検査が 1 件も無ければ 3 つとも null", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a")] }));
    expect(metrics.firstPassRate.permille).toBeNull();
    expect(metrics.reworkRate.permille).toBeNull();
    expect(metrics.selfInspectionRate.permille).toBeNull();
  });

  it("判定が未確定（result = null）は合格に数えない", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a")], inspections: [inspection("a", { result: null })] }),
    );
    expect(metrics.firstPassRate).toEqual({ numerator: 0, denominator: 1, permille: 0 });
  });

  it("検査の無いタスクに差戻しが付いていても再清掃率に乗らない", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a")], reworks: [{ taskId: "a" }] }),
    );
    expect(metrics.reworkRate).toEqual({ numerator: 0, denominator: 0, permille: null });
  });

  it("知らないタスクの検査は分母を増やさない", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a")], inspections: [inspection("zzz")] }),
    );
    expect(metrics.inspectedTasks).toBe(0);
  });
});

describe("computePropertyMetrics — ④⑥ 検査待ち時間と SLA 超過率", () => {
  // ── 正例 ────────────────────────────────────────────────
  it("平均検査待ち時間 = Round 1 開始 - 清掃完了", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a"), task("b")],
        inspections: [
          inspection("a", { startedAtMs: BASE + minutes(10) }),
          inspection("b", { startedAtMs: BASE + minutes(20) }),
        ],
      }),
    );
    expect(metrics.inspectionWaitMinutes).toEqual({ count: 2, minutes: 15 });
  });

  it("Round 2 の開始時刻を待ち時間に混ぜない", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a")],
        inspections: [
          inspection("a", { result: "FAIL", startedAtMs: BASE + minutes(6) }),
          inspection("a", { round: 2, startedAtMs: BASE + minutes(90) }),
        ],
      }),
    );
    expect(metrics.inspectionWaitMinutes).toEqual({ count: 1, minutes: 6 });
  });

  it("SLA を超えた件数を数える", () => {
    const metrics = computePropertyMetrics(
      build({
        slaMinutes: 20,
        tasks: [task("a"), task("b"), task("c")],
        inspections: [
          inspection("a", { startedAtMs: BASE + minutes(5) }),
          inspection("b", { startedAtMs: BASE + minutes(21) }),
          inspection("c", { startedAtMs: BASE + minutes(40) }),
        ],
      }),
    );
    expect(metrics.slaBreachRate).toEqual({ numerator: 2, denominator: 3, permille: 667 });
  });

  it("SLA ちょうどは超過にしない（§5.2 の「超えて」）", () => {
    const metrics = computePropertyMetrics(
      build({
        slaMinutes: 20,
        tasks: [task("a")],
        inspections: [inspection("a", { startedAtMs: BASE + minutes(20) })],
      }),
    );
    expect(metrics.slaBreachRate.numerator).toBe(0);
  });

  it("slaMinutes を結果に写す（画面が閾値を出せる）", () => {
    expect(computePropertyMetrics(build({ slaMinutes: 45 })).slaMinutes).toBe(45);
  });

  // ── 負例 ────────────────────────────────────────────────
  it("清掃完了の記録が無ければ待ち時間を測らない", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a", { completedAtMs: null })],
        inspections: [inspection("a")],
      }),
    );
    expect(metrics.inspectionWaitMinutes).toEqual({ count: 0, minutes: null });
    expect(metrics.slaBreachRate.denominator).toBe(0);
  });

  it("測れなかったタスクは SLA の分母に入らない（静かに率を下げない）", () => {
    const metrics = computePropertyMetrics(
      build({
        slaMinutes: 20,
        tasks: [task("a"), task("b", { completedAtMs: null })],
        inspections: [inspection("a", { startedAtMs: BASE + minutes(30) }), inspection("b")],
      }),
    );
    expect(metrics.slaBreachRate).toEqual({ numerator: 1, denominator: 1, permille: 1000 });
  });

  it("検査が完了より前に始まっていても負にしない", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a")],
        inspections: [inspection("a", { startedAtMs: BASE - minutes(5) })],
      }),
    );
    expect(metrics.inspectionWaitMinutes.minutes).toBe(0);
  });

  it("検査が 1 件も無ければ両方とも空", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a")] }));
    expect(metrics.inspectionWaitMinutes.minutes).toBeNull();
    expect(metrics.slaBreachRate.permille).toBeNull();
  });

  it("slaMinutes が小数なら RangeError", () => {
    expect(() => computePropertyMetrics(build({ slaMinutes: 20.5 }))).toThrow(RangeError);
  });

  it("slaMinutes が負なら RangeError", () => {
    expect(() => computePropertyMetrics(build({ slaMinutes: -1 }))).toThrow(RangeError);
  });
});

describe("computePropertyMetrics — ⑤ 平均実作業時間", () => {
  // ── 正例 ────────────────────────────────────────────────
  it("施設全体の平均を出す", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [
          task("a", { actualMinutes: 20 }),
          task("b", { actualMinutes: 30 }),
          task("c", { actualMinutes: 40 }),
        ],
      }),
    );
    expect(metrics.actualMinutes).toEqual({ count: 3, minutes: 30 });
  });

  it("種別 × 客室タイプで分解する（§10.1）", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [
          task("a", { taskType: "CHECKOUT", roomTypeId: "rt_twin", actualMinutes: 30 }),
          task("b", { taskType: "CHECKOUT", roomTypeId: "rt_twin", actualMinutes: 40 }),
          task("c", { taskType: "STAYOVER", roomTypeId: "rt_twin", actualMinutes: 15 }),
        ],
      }),
    );
    expect(metrics.actualMinutesByGroup).toEqual([
      { taskType: "CHECKOUT", roomTypeId: "rt_twin", average: { count: 2, minutes: 35 } },
      { taskType: "STAYOVER", roomTypeId: "rt_twin", average: { count: 1, minutes: 15 } },
    ]);
  });

  it("客室タイプが違えば別グループになる", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [
          task("a", { roomTypeId: "rt_single", actualMinutes: 20 }),
          task("b", { roomTypeId: "rt_suite", actualMinutes: 60 }),
        ],
      }),
    );
    expect(metrics.actualMinutesByGroup).toHaveLength(2);
  });

  it("客室タイプの無いタスク（共用部）も 1 グループにする", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a", { taskType: "COMMON_AREA", roomTypeId: null, actualMinutes: 25 })],
      }),
    );
    expect(metrics.actualMinutesByGroup).toEqual([
      { taskType: "COMMON_AREA", roomTypeId: null, average: { count: 1, minutes: 25 } },
    ]);
  });

  it("グループの並びは入力順に依存しない", () => {
    const forward = computePropertyMetrics(
      build({
        tasks: [
          task("a", { taskType: "STAYOVER", actualMinutes: 10 }),
          task("b", { taskType: "CHECKOUT", actualMinutes: 20 }),
        ],
      }),
    );
    const backward = computePropertyMetrics(
      build({
        tasks: [
          task("b", { taskType: "CHECKOUT", actualMinutes: 20 }),
          task("a", { taskType: "STAYOVER", actualMinutes: 10 }),
        ],
      }),
    );
    expect(forward.actualMinutesByGroup).toEqual(backward.actualMinutesByGroup);
  });

  // ── 負例 ────────────────────────────────────────────────
  it("計測できていない（null）タスクを 0 分として混ぜない", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a", { actualMinutes: 30 }), task("b", { actualMinutes: null })],
      }),
    );
    expect(metrics.actualMinutes).toEqual({ count: 1, minutes: 30 });
  });

  it("CANCELLED は平均に入れない（作業していない）", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [
          task("a", { actualMinutes: 30 }),
          task("b", { status: "CANCELLED", actualMinutes: 2 }),
        ],
      }),
    );
    expect(metrics.actualMinutes).toEqual({ count: 1, minutes: 30 });
  });

  it("記録が 1 件も無ければ null とグループ 0 件", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a", { actualMinutes: null })] }));
    expect(metrics.actualMinutes.minutes).toBeNull();
    expect(metrics.actualMinutesByGroup).toEqual([]);
  });

  it("タスクが無ければグループも空", () => {
    expect(computePropertyMetrics(build()).actualMinutesByGroup).toEqual([]);
  });

  it("未完了でも実作業時間の記録があれば平均に入る（中断中の実績）", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a", { status: "PAUSED", actualMinutes: 12 })] }),
    );
    expect(metrics.actualMinutes).toEqual({ count: 1, minutes: 12 });
  });
});

describe("computePropertyMetrics — 全体", () => {
  it("入力を書き換えない", () => {
    const tasks = [task("b"), task("a")];
    const inspections = [inspection("b", { round: 2 }), inspection("b", { round: 1 })];
    const snapshot = JSON.stringify({ tasks, inspections });
    computePropertyMetrics(build({ tasks, inspections }));
    expect(JSON.stringify({ tasks, inspections })).toBe(snapshot);
  });

  it("期間をそのまま写す", () => {
    const metrics = computePropertyMetrics(
      build({ periodFrom: "2026-09-01", periodTo: "2026-09-30" }),
    );
    expect(metrics.periodFrom).toBe("2026-09-01");
    expect(metrics.periodTo).toBe("2026-09-30");
  });

  it("7 指標がすべて出る（§10.1）", () => {
    const metrics = computePropertyMetrics(
      build({
        tasks: [task("a")],
        inspections: [inspection("a")],
      }),
    );
    for (const key of PROPERTY_METRIC_KEYS) {
      expect(metrics[key]).toBeDefined();
    }
    expect(PROPERTY_METRIC_KEYS).toHaveLength(7);
  });

  it("同じ入力から同じ結果（決定性）", () => {
    const input = build({
      tasks: [task("a", { actualMinutes: 26 }), task("b", { actualMinutes: 27 })],
      inspections: [inspection("a"), inspection("b", { startedAtMs: BASE + minutes(25) })],
      reworks: [{ taskId: "b" }],
    });
    expect(computePropertyMetrics(input)).toEqual(computePropertyMetrics(input));
  });
});

/**
 * INV-01〜03 の作り付けの担保。
 *
 * 個人別の指標は**入力の型に担当者が無い**ことで塞いである。型は実行時に
 * 消えるので、代わりにモジュールの本文へ担当者の語が入っていないことを
 * 見る（CI の `forbidden-words` と同じ発想）。ここが赤くなったら、
 * 指標を個人別に分解しようとしている。
 */
describe("INV-02 / INV-03 個人単位の指標を作らない", () => {
  const source = readFileSync(fileURLToPath(new URL("./metrics.ts", import.meta.url)), "utf8");

  /** 本文（コメントに書かれた注記まで弾かないよう、行コメントを落とす）。 */
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");

  it.each(["assignee", "staff", "inspector", "userId", "membership", "ranking", "rank"])(
    "識別子に %s を持たない",
    (word) => {
      expect(code.toLowerCase()).not.toContain(word.toLowerCase());
    },
  );

  it("出力に個人を指す項目が無い", () => {
    const metrics = computePropertyMetrics(
      build({ tasks: [task("a")], inspections: [inspection("a")] }),
    );
    const keys = JSON.stringify(metrics).toLowerCase();
    expect(keys).not.toContain("assignee");
    expect(keys).not.toContain("inspector");
  });

  it("分解軸は作業種別と客室タイプだけ（INV-03）", () => {
    const metrics = computePropertyMetrics(build({ tasks: [task("a", { actualMinutes: 30 })] }));
    expect(Object.keys(metrics.actualMinutesByGroup[0] ?? {})).toEqual([
      "taskType",
      "roomTypeId",
      "average",
    ]);
  });
});
