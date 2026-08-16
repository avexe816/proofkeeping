/**
 * 月次レポートの集計の検査。
 *
 * 台帳: docs/PROTOTYPE_GAP.md 第2批 09 / DECISIONS #196
 * ルール: .claude/rules/testing.md §3（正例と負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  computeMonthlyReport,
  medianMinutes,
  type MonthlyReportFindingInput,
  type MonthlyReportInput,
  type MonthlyReportTaskInput,
} from "./monthlyReport.js";

/** 完了タスク 1 件（必要な項目だけ上書きする）。 */
function task(overrides: Partial<MonthlyReportTaskInput> = {}): MonthlyReportTaskInput {
  return {
    taskType: "CHECKOUT",
    status: "COMPLETED",
    actualMinutes: 40,
    inspectionResult: null,
    reworkCount: 0,
    hasObservation: true,
    ...overrides,
  };
}

function finding(overrides: Partial<MonthlyReportFindingInput> = {}): MonthlyReportFindingInput {
  return { ruleCode: "R001", severity: "HIGH", status: "OPEN", ...overrides };
}

function reportInput(overrides: Partial<MonthlyReportInput> = {}): MonthlyReportInput {
  return {
    month: "2026-07",
    from: "2026-07-01",
    to: "2026-07-31",
    tasks: [],
    findings: [],
    linen: [],
    previous: null,
    ...overrides,
  };
}

describe("medianMinutes", () => {
  // 正例
  it("奇数個は中央の値", () => {
    expect(medianMinutes([10, 40, 30])).toBe(30);
  });
  it("偶数個は中央 2 つの平均", () => {
    expect(medianMinutes([10, 20, 30, 40])).toBe(25);
  });
  it("偶数個の平均は四捨五入する", () => {
    expect(medianMinutes([10, 11])).toBe(11); // 10.5 → 11
  });
  it("1 件ならその値", () => {
    expect(medianMinutes([37])).toBe(37);
  });
  it("外れ値 1 件で中央値は動かない", () => {
    expect(medianMinutes([38, 39, 40, 41, 400])).toBe(40);
  });
  // 負例
  it("空なら null（0 と区別する）", () => {
    expect(medianMinutes([])).toBeNull();
  });
  it("入力の配列を破壊しない", () => {
    const values = [30, 10, 20];
    medianMinutes(values);
    expect(values).toEqual([30, 10, 20]);
  });
});

describe("computeMonthlyReport: §1 概要", () => {
  // 正例
  it("完了件数は COMPLETED だけを数える", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [task(), task(), task({ status: "IN_PROGRESS" }), task({ status: "CANCELLED" })],
      }),
    );
    expect(report.summary.completedTasks.count).toBe(2);
  });

  it("記録の完備率の分母は月の全タスク（キャンセル済みも含む）", () => {
    // `collectDataQuality()` の入力率と同じ数え方。
    const report = computeMonthlyReport(
      reportInput({
        tasks: [
          task({ hasObservation: true }),
          task({ hasObservation: true, status: "CANCELLED" }),
          task({ hasObservation: false }),
          task({ hasObservation: false }),
        ],
      }),
    );
    expect(report.summary.recordRate.rate).toEqual({
      numerator: 2,
      denominator: 4,
      permille: 500,
    });
  });

  it("差異率は差異 ÷ 完了タスク", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [task(), task(), task(), task()],
        findings: [finding()],
      }),
    );
    expect(report.summary.findingRate.rate.permille).toBe(250);
  });

  it("再清掃率の分母は検査結果が確定したタスク（完了数ではない）", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [
          task({ inspectionResult: "PASS", reworkCount: 1 }),
          task({ inspectionResult: "PASS" }),
          task({ inspectionResult: "FAIL", reworkCount: 1 }),
          task({ inspectionResult: "PASS" }),
          // 検査に回っていない完了タスク。分母に入らない。
          task(),
          task(),
        ],
      }),
    );
    expect(report.summary.reworkRate.rate).toEqual({
      numerator: 2,
      denominator: 4,
      permille: 500,
    });
  });

  it("前月比: 件数は増減の千分率", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: Array.from({ length: 21 }, () => task()),
        previous: { tasks: Array.from({ length: 20 }, () => task()), findings: [] },
      }),
    );
    expect(report.summary.completedTasks.changePermille).toBe(50); // +5.0%
  });

  it("前月比: 率は千分率の差（比ではない）", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [task({ hasObservation: true }), task({ hasObservation: false })], // 50.0%
        previous: {
          tasks: [
            task({ hasObservation: true }),
            task({ hasObservation: true }),
            task({ hasObservation: true }),
            task({ hasObservation: false }),
          ], // 75.0%
          findings: [],
        },
      }),
    );
    expect(report.summary.recordRate.changePermille).toBe(-250); // −25.0pt
  });

  // 負例
  it("前月が無ければ前月比はすべて null", () => {
    const report = computeMonthlyReport(reportInput({ tasks: [task()] }));
    expect(report.summary.completedTasks.changePermille).toBeNull();
    expect(report.summary.recordRate.changePermille).toBeNull();
    expect(report.summary.findingRate.changePermille).toBeNull();
    expect(report.summary.reworkRate.changePermille).toBeNull();
  });

  it("前月の完了が 0 件なら件数の前月比は null（0 で割らない）", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [task()],
        previous: { tasks: [task({ status: "CANCELLED" })], findings: [] },
      }),
    );
    expect(report.summary.completedTasks.changePermille).toBeNull();
  });

  it("当月の分母が 0 なら率は null のまま前月比も null", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [],
        previous: { tasks: [task()], findings: [] },
      }),
    );
    expect(report.summary.recordRate.rate.permille).toBeNull();
    expect(report.summary.recordRate.changePermille).toBeNull();
  });

  it("タスクが 1 件も無い月でも例外にならない", () => {
    const report = computeMonthlyReport(reportInput());
    expect(report.summary.completedTasks.count).toBe(0);
    expect(report.taskTypes).toEqual([]);
    expect(report.findingsByRule).toEqual([]);
    expect(report.linen).toEqual([]);
    expect(report.linenTotals).toEqual({ collectedQty: 0, suppliedQty: 0, delta: 0 });
  });
});

describe("computeMonthlyReport: §2 作業種別", () => {
  // 正例
  it("完了件数の多い順に並ぶ", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [
          task({ taskType: "STAYOVER" }),
          task({ taskType: "CHECKOUT" }),
          task({ taskType: "CHECKOUT" }),
          task({ taskType: "RECHECK" }),
          task({ taskType: "STAYOVER" }),
          task({ taskType: "CHECKOUT" }),
        ],
      }),
    );
    expect(report.taskTypes.map((row) => row.taskType)).toEqual([
      "CHECKOUT",
      "STAYOVER",
      "RECHECK",
    ]);
  });

  it("同数なら種別コードの辞書順（決定性）", () => {
    const report = computeMonthlyReport(
      reportInput({ tasks: [task({ taskType: "STAYOVER" }), task({ taskType: "CHECKOUT" })] }),
    );
    expect(report.taskTypes.map((row) => row.taskType)).toEqual(["CHECKOUT", "STAYOVER"]);
  });

  it("中央値は計測できた完了タスクだけから出す", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [
          task({ actualMinutes: 30 }),
          task({ actualMinutes: 50 }),
          task({ actualMinutes: null }),
        ],
      }),
    );
    expect(report.taskTypes[0]?.medianMinutes).toBe(40);
    expect(report.taskTypes[0]?.completedCount).toBe(3);
  });

  // 負例
  it("未完了のタスクは種別の表に入らない", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [task({ taskType: "DEEP", status: "IN_PROGRESS" }), task({ taskType: "CHECKOUT" })],
      }),
    );
    expect(report.taskTypes.map((row) => row.taskType)).toEqual(["CHECKOUT"]);
  });

  it("計測できた完了タスクが無い種別の中央値は null", () => {
    const report = computeMonthlyReport(
      reportInput({ tasks: [task({ actualMinutes: null })] }),
    );
    expect(report.taskTypes[0]?.medianMinutes).toBeNull();
  });
});

describe("computeMonthlyReport: §3 差異", () => {
  // 正例
  it("ルールごとに件数と確認済み件数を数える", () => {
    const report = computeMonthlyReport(
      reportInput({
        findings: [
          finding({ status: "RESOLVED" }),
          finding({ status: "FALSE_POSITIVE" }),
          finding({ status: "OPEN" }),
        ],
      }),
    );
    expect(report.findingsByRule).toEqual([
      { ruleCode: "R001", severity: "HIGH", totalCount: 3, reviewedCount: 2 },
    ]);
  });

  it("重要度の高い順 → 件数の多い順に並ぶ", () => {
    const report = computeMonthlyReport(
      reportInput({
        findings: [
          finding({ ruleCode: "R008", severity: "LOW" }),
          finding({ ruleCode: "R003", severity: "MEDIUM" }),
          finding({ ruleCode: "R003", severity: "MEDIUM" }),
          finding({ ruleCode: "R005", severity: "MEDIUM" }),
          finding({ ruleCode: "R001", severity: "HIGH" }),
        ],
      }),
    );
    expect(report.findingsByRule.map((row) => row.ruleCode)).toEqual([
      "R001",
      "R003",
      "R005",
      "R008",
    ]);
  });

  it("同じルールで重要度が割れたら高い方を出す", () => {
    // 施設の上書き（§2.7）で月の途中に重要度が変わった場合。
    const report = computeMonthlyReport(
      reportInput({
        findings: [
          finding({ ruleCode: "R003", severity: "LOW" }),
          finding({ ruleCode: "R003", severity: "MEDIUM" }),
        ],
      }),
    );
    expect(report.findingsByRule[0]?.severity).toBe("MEDIUM");
  });

  it("差異率の分子も抑制済みを除いた数", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [task(), task()],
        findings: [finding(), finding({ status: "SUPPRESSED" })],
      }),
    );
    expect(report.summary.findingRate.rate.numerator).toBe(1);
  });

  it("前月比の分子も抑制済みを除いた数", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [task()],
        findings: [finding()],
        previous: {
          tasks: [task()],
          findings: [finding(), finding({ status: "SUPPRESSED" })],
        },
      }),
    );
    // 当月 1/1、前月も（抑制を除けば）1/1 → 差 0pt。
    expect(report.summary.findingRate.changePermille).toBe(0);
  });

  // 負例
  it("SUPPRESSED はルール別の表に載らない", () => {
    const report = computeMonthlyReport(
      reportInput({ findings: [finding({ status: "SUPPRESSED" })] }),
    );
    expect(report.findingsByRule).toEqual([]);
  });

  it("表に無い重要度の値は最後に並ぶ", () => {
    const report = computeMonthlyReport(
      reportInput({
        findings: [
          finding({ ruleCode: "R010", severity: "UNKNOWN" }),
          finding({ ruleCode: "R008", severity: "LOW" }),
        ],
      }),
    );
    expect(report.findingsByRule.map((row) => row.ruleCode)).toEqual(["R008", "R010"]);
  });
});

describe("computeMonthlyReport: §4 検査と再清掃", () => {
  // 正例
  it("検査数・合格数・合格率・抜き取り割合・再清掃数を出す", () => {
    const report = computeMonthlyReport(
      reportInput({
        tasks: [
          task({ inspectionResult: "PASS" }),
          task({ inspectionResult: "PASS", reworkCount: 1 }),
          task({ inspectionResult: "FAIL", reworkCount: 1 }),
          task(),
        ],
      }),
    );
    expect(report.inspection).toEqual({
      inspectedTasks: 3,
      passedTasks: 2,
      passRate: { numerator: 2, denominator: 3, permille: 667 },
      inspectionCoverage: { numerator: 3, denominator: 4, permille: 750 },
      reworkTasks: 2,
    });
  });

  // 負例
  it("検査が 1 件も無ければ合格率は null（0% と区別する）", () => {
    const report = computeMonthlyReport(reportInput({ tasks: [task()] }));
    expect(report.inspection.passRate.permille).toBeNull();
  });

  it("PASS / FAIL 以外の値は検査数に入らない", () => {
    const report = computeMonthlyReport(
      reportInput({ tasks: [task({ inspectionResult: "PENDING" })] }),
    );
    expect(report.inspection.inspectedTasks).toBe(0);
  });
});

describe("computeMonthlyReport: §5 リネン", () => {
  // 正例
  it("差分は補充 − 回収で、合計行も同じ式", () => {
    const report = computeMonthlyReport(
      reportInput({
        linen: [
          { itemCode: "BATH_TOWEL", collectedQty: 100, suppliedQty: 110 },
          { itemCode: "SHEET_SINGLE", collectedQty: 50, suppliedQty: 48 },
        ],
      }),
    );
    expect(report.linen).toEqual([
      { itemCode: "BATH_TOWEL", collectedQty: 100, suppliedQty: 110, delta: 10 },
      { itemCode: "SHEET_SINGLE", collectedQty: 50, suppliedQty: 48, delta: -2 },
    ]);
    expect(report.linenTotals).toEqual({ collectedQty: 150, suppliedQty: 158, delta: 8 });
  });

  it("入力の順序を変えない（並びは呼び出し側の責務）", () => {
    const report = computeMonthlyReport(
      reportInput({
        linen: [
          { itemCode: "YUKATA", collectedQty: 1, suppliedQty: 1 },
          { itemCode: "BATH_TOWEL", collectedQty: 1, suppliedQty: 1 },
        ],
      }),
    );
    expect(report.linen.map((row) => row.itemCode)).toEqual(["YUKATA", "BATH_TOWEL"]);
  });
});
