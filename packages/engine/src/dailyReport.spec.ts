/**
 * 日報の集計の検査（PK-SPEC-P2 §9.2）。
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/testing.md §3（全ルールに正例と負例を 5 件ずつ）
 *
 * ── 何を固定しているか ──────────────────────────────────
 * ① サマリーが**明細を数えた結果と必ず一致する**こと（完了条件
 *    「PDF の集計値と DB 明細が一致する」の実体）。
 * ② 同じ入力から同じ payload が出ること（順序の正規化）。
 * ③ 検査のラウンドの読み方（初回合格・差戻し・再清掃後合格・自己検査）。
 */

import { describe, expect, it } from "vitest";

import {
  buildDailyReportPayload,
  dailyReportCounters,
  dailyReportPayloadToCanonical,
  type DailyReportInput,
  type DailyReportInspectionInput,
  type DailyReportTaskInput,
} from "./dailyReport.js";
import { canonicalJson } from "./evidence.js";

const GENERATED_AT = Date.UTC(2026, 8, 10, 20, 10, 0);

function task(overrides: Partial<DailyReportTaskInput> = {}): DailyReportTaskInput {
  return {
    taskId: "t1",
    roomNumber: "302",
    taskType: "CHECKOUT",
    status: "COMPLETED",
    assigneeName: "田中",
    startedAtMs: Date.UTC(2026, 8, 10, 4, 30, 0),
    completedAtMs: Date.UTC(2026, 8, 10, 5, 2, 0),
    actualMinutes: 32,
    blockedReason: null,
    ...overrides,
  };
}

function inspection(
  overrides: Partial<DailyReportInspectionInput> = {},
): DailyReportInspectionInput {
  return {
    taskId: "t1",
    round: 1,
    inspectorName: "佐藤",
    result: "PASS",
    selfApproved: false,
    ...overrides,
  };
}

function input(overrides: Partial<DailyReportInput> = {}): DailyReportInput {
  return {
    documentNo: "RPT-2026-0042",
    revision: 1,
    businessDate: "2026-09-10",
    generatedAtMs: GENERATED_AT,
    property: { code: "HTLA", name: "サンプルホテル東京", timezone: "Asia/Tokyo" },
    tasks: [task()],
    inspections: [inspection()],
    reworks: [],
    findings: [],
    ...overrides,
  };
}

describe("サマリーは明細を数えた結果と一致する", () => {
  it.each([
    ["1 件すべて完了", 1, 1],
    ["3 件中 2 件完了", 3, 2],
    ["5 件中 0 件完了", 5, 0],
    ["8 件すべて完了", 8, 8],
    ["12 件中 7 件完了", 12, 7],
  ])("%s", (_label, total, completed) => {
    const tasks = Array.from({ length: total }, (_unused, index) =>
      task({
        taskId: `t${String(index)}`,
        roomNumber: String(300 + index),
        status: index < completed ? "COMPLETED" : "AWAITING_INSPECTION",
      }),
    );
    const payload = buildDailyReportPayload(input({ tasks, inspections: [] }));

    expect(payload.summary.totalTasks).toBe(payload.details.length);
    expect(payload.summary.completedTasks).toBe(completed);
    expect(payload.summary.incompleteTasks).toBe(payload.incomplete.length);
    expect(payload.summary.completedTasks + payload.summary.incompleteTasks).toBe(total);
  });

  it.each([
    ["完了しか無い日は未完了の節が空", "COMPLETED", 0],
    ["検査待ちは未完了", "AWAITING_INSPECTION", 1],
    ["再清掃中は未完了", "REWORK", 1],
    ["入室不可は未完了", "BLOCKED", 1],
    ["取消も未完了に数える（作業していない）", "CANCELLED", 1],
  ])("%s", (_label, status, expected) => {
    const payload = buildDailyReportPayload(input({ tasks: [task({ status })], inspections: [] }));
    expect(payload.incomplete).toHaveLength(expected);
  });
});

describe("検査のラウンドの読み方", () => {
  it("初回 PASS は初回合格", () => {
    const payload = buildDailyReportPayload(input());
    expect(payload.summary.passedFirstRound).toBe(1);
    expect(payload.summary.reworkedTasks).toBe(0);
    expect(payload.summary.passedAfterRework).toBe(0);
  });

  it("初回 FAIL → 2 回目 PASS は「差戻し」と「再清掃後合格」の両方に数える", () => {
    const payload = buildDailyReportPayload(
      input({
        inspections: [
          inspection({ round: 1, result: "FAIL" }),
          inspection({ round: 2, result: "PASS" }),
        ],
      }),
    );
    expect(payload.summary.passedFirstRound).toBe(0);
    expect(payload.summary.reworkedTasks).toBe(1);
    expect(payload.summary.passedAfterRework).toBe(1);
  });

  it("初回 FAIL のまま日締めを迎えたら再清掃後合格に数えない", () => {
    const payload = buildDailyReportPayload(
      input({ inspections: [inspection({ round: 1, result: "FAIL" })] }),
    );
    expect(payload.summary.reworkedTasks).toBe(1);
    expect(payload.summary.passedAfterRework).toBe(0);
  });

  it("検査の記録が無いタスクは検査対象に数えない", () => {
    const payload = buildDailyReportPayload(input({ inspections: [] }));
    expect(payload.summary.inspectedTasks).toBe(0);
    expect(payload.summary.passedFirstRound).toBe(0);
  });

  it("結果が未確定（検査中に日締め）でも検査対象には数える", () => {
    const payload = buildDailyReportPayload(
      input({ inspections: [inspection({ result: null })] }),
    );
    expect(payload.summary.inspectedTasks).toBe(1);
    expect(payload.summary.passedFirstRound).toBe(0);
    expect(payload.summary.reworkedTasks).toBe(0);
  });

  it("自己検査は 1 タスク 1 件として数える", () => {
    const payload = buildDailyReportPayload(
      input({
        inspections: [
          inspection({ round: 1, result: "FAIL", selfApproved: true }),
          inspection({ round: 2, result: "PASS", selfApproved: true }),
        ],
      }),
    );
    expect(payload.summary.selfInspectedTasks).toBe(1);
  });

  it("入力のラウンドが逆順でも初回は round 1 で決まる", () => {
    const payload = buildDailyReportPayload(
      input({
        inspections: [
          inspection({ round: 2, result: "PASS", inspectorName: "鈴木" }),
          inspection({ round: 1, result: "FAIL" }),
        ],
      }),
    );
    expect(payload.summary.reworkedTasks).toBe(1);
    expect(payload.summary.passedAfterRework).toBe(1);
    // 明細の検査者・結果は**最後のラウンド**。
    expect(payload.details[0]?.inspectorName).toBe("鈴木");
    expect(payload.details[0]?.inspectionResult).toBe("PASS");
  });
});

describe("明細の並び", () => {
  it("部屋番号を数として並べる（1001 は 302 の後）", () => {
    const payload = buildDailyReportPayload(
      input({
        tasks: [
          task({ taskId: "a", roomNumber: "1001" }),
          task({ taskId: "b", roomNumber: "302" }),
          task({ taskId: "c", roomNumber: "45" }),
        ],
        inspections: [],
      }),
    );
    expect(payload.details.map((row) => row.roomNumber)).toEqual(["45", "302", "1001"]);
  });

  it("入力の順序が違っても同じ payload になる（決定的）", () => {
    const tasks = [
      task({ taskId: "a", roomNumber: "1001" }),
      task({ taskId: "b", roomNumber: "302" }),
    ];
    const forward = buildDailyReportPayload(input({ tasks, inspections: [] }));
    const reversed = buildDailyReportPayload(input({ tasks: [...tasks].reverse(), inspections: [] }));

    expect(canonicalJson(dailyReportPayloadToCanonical(forward))).toBe(
      canonicalJson(dailyReportPayloadToCanonical(reversed)),
    );
  });

  it("差戻しの件数が明細の再清掃列に出る", () => {
    const payload = buildDailyReportPayload(
      input({
        reworks: [
          { taskId: "t1", round: 1, status: "RESOLVED" },
          { taskId: "t1", round: 2, status: "OPEN" },
        ],
      }),
    );
    expect(payload.details[0]?.reworkCount).toBe(2);
  });

  it("実作業分の null（計測できていない）を 0 に潰さない", () => {
    const payload = buildDailyReportPayload(
      input({ tasks: [task({ actualMinutes: null })], inspections: [] }),
    );
    expect(payload.details[0]?.actualMinutes).toBeNull();
  });

  it("時刻は ISO 8601 UTC の文字列（現地時刻へ整形しない）", () => {
    const payload = buildDailyReportPayload(input());
    expect(payload.details[0]?.startedAt).toBe("2026-09-10T04:30:00.000Z");
    expect(payload.generatedAt).toBe("2026-09-10T20:10:00.000Z");
  });
});

describe("不具合・忘れ物", () => {
  const findings = [
    { reference: "L-0002", roomNumber: "1001", kind: "VALUABLE", status: "STORED" as const },
    { reference: "L-0001", roomNumber: "302", kind: "CLOTHING", status: "FOUND" as const },
  ].map((row) => ({ ...row, source: "LOST_ITEM" as const }));

  it("忘れ物と不具合を分けて数える", () => {
    const payload = buildDailyReportPayload(
      input({
        findings: [
          ...findings,
          { reference: "I-1", roomNumber: "302", kind: "PLUMBING", status: "OPEN", source: "ISSUE" },
        ],
      }),
    );
    const counters = dailyReportCounters(payload);
    expect(counters.openLostItems).toBe(2);
    expect(counters.openIssues).toBe(1);
  });

  it("並びは 種別 → 部屋番号 → 参照番号 で決まる", () => {
    const payload = buildDailyReportPayload(input({ findings }));
    expect(payload.findings.map((row) => row.reference)).toEqual(["L-0001", "L-0002"]);
  });

  it("1 件も無ければ空", () => {
    const payload = buildDailyReportPayload(input());
    expect(payload.findings).toEqual([]);
    expect(dailyReportCounters(payload).openIssues).toBe(0);
  });
});

describe("DB へ入れる集計値", () => {
  it("payload の値をそのまま取り出す（数え直さない）", () => {
    const payload = buildDailyReportPayload(
      input({
        tasks: [
          task({ taskId: "a", roomNumber: "302" }),
          task({ taskId: "b", roomNumber: "303", status: "BLOCKED" }),
        ],
        inspections: [
          inspection({ taskId: "a", round: 1, result: "FAIL" }),
          inspection({ taskId: "a", round: 2, result: "PASS" }),
        ],
      }),
    );
    const counters = dailyReportCounters(payload);

    expect(counters.totalTasks).toBe(payload.summary.totalTasks);
    expect(counters.completedTasks).toBe(payload.summary.completedTasks);
    expect(counters.failedFirstInspection).toBe(payload.summary.reworkedTasks);
  });

  it.each([
    ["空の日報", 0],
    ["1 件", 1],
    ["3 件", 3],
    ["10 件", 10],
    ["25 件", 25],
  ])("%s でも totalTasks と明細の行数が一致する", (_label, total) => {
    const tasks = Array.from({ length: total }, (_unused, index) =>
      task({ taskId: `t${String(index)}`, roomNumber: String(300 + index) }),
    );
    const payload = buildDailyReportPayload(input({ tasks, inspections: [] }));
    expect(dailyReportCounters(payload).totalTasks).toBe(payload.details.length);
  });
});

describe("正規化 JSON", () => {
  it("canonicalJson に通せる（整数と文字列だけで出来ている）", () => {
    const payload = buildDailyReportPayload(input());
    expect(() => canonicalJson(dailyReportPayloadToCanonical(payload))).not.toThrow();
  });

  it("同じ入力からは同じ文字列（ハッシュが再現する）", () => {
    const first = canonicalJson(dailyReportPayloadToCanonical(buildDailyReportPayload(input())));
    const second = canonicalJson(dailyReportPayloadToCanonical(buildDailyReportPayload(input())));
    expect(first).toBe(second);
  });

  it("版が違えば payload も違う（再生成が別の文書になる）", () => {
    const first = canonicalJson(dailyReportPayloadToCanonical(buildDailyReportPayload(input())));
    const second = canonicalJson(
      dailyReportPayloadToCanonical(buildDailyReportPayload(input({ revision: 2 }))),
    );
    expect(first).not.toBe(second);
  });
});
