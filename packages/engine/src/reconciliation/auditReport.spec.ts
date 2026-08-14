/**
 * 月次監査レポートの payload（PK-SPEC-P4 §7）。
 *
 * ルール: .claude/rules/testing.md §3
 *
 * ── いちばん大事なテスト ────────────────────────────────
 * §7.2 MUST「この文言を削除・編集できない実装にする」。
 * **免責文を文字列そのもので固定する。** 句読点 1 つ変えても落ちる。
 */

import { describe, expect, it } from "vitest";

import {
  AUDIT_REPORT_DISCLAIMER,
  buildAuditReportPayload,
  buildRuleLines,
  type AuditFindingLine,
  type AuditReportInput,
} from "./auditReport.js";

function line(overrides: Partial<AuditFindingLine> = {}): AuditFindingLine {
  return {
    businessDate: "2026-09-09",
    roomNumber: "302",
    ruleCode: "R001",
    severity: "HIGH",
    confidence: 80,
    title: "302 号室：稼働記録のない使用痕跡",
    status: "OPEN",
    resolutionCode: null,
    ...overrides,
  };
}

function input(overrides: Partial<AuditReportInput> = {}): AuditReportInput {
  return {
    property: { id: "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH", name: "サンプルホテル東京" },
    month: "2026-09",
    from: "2026-09-01",
    to: "2026-09-30",
    engineVersion: "1.1",
    rulesetHash: "a3f9c2",
    roomDays: 1800,
    availableSources: ["occupancy", "observation"],
    suppressedCount: 6,
    findings: [],
    trend: [],
    rules: [],
    ...overrides,
  };
}

describe("免責事項（§7.2 MUST・全文固定）", () => {
  it("文言が一字一句そのまま", () => {
    expect(AUDIT_REPORT_DISCLAIMER).toBe(
      "本レポートは、清掃現場の記録と稼働記録の差異を機械的に抽出したものであり、" +
        "特定の個人による不正行為を認定するものではありません。" +
        "差異には、設備の不具合、記録の遅延や漏れ、業務手順上の例外、" +
        "システム連携のタイムラグなど、多様な原因が含まれます。" +
        "本レポートの内容を根拠として人事上の措置を行う場合は、" +
        "必ず個別の事実確認を実施してください。",
    );
  });

  it("payload に必ず入る", () => {
    expect(buildAuditReportPayload(input()).disclaimer).toBe(AUDIT_REPORT_DISCLAIMER);
  });

  it("**入力から差し替えられない**（`disclaimer` を受け取る欄が無い）", () => {
    const withDisclaimer = { ...input(), disclaimer: "書き換えた文言" } as AuditReportInput;
    expect(buildAuditReportPayload(withDisclaimer).disclaimer).toBe(AUDIT_REPORT_DISCLAIMER);
  });

  it("空文字にできない", () => {
    expect(AUDIT_REPORT_DISCLAIMER.length).toBeGreaterThan(100);
  });
});

describe("サマリー（§7.1 の 1.）", () => {
  it("重要度ごとに数える", () => {
    const payload = buildAuditReportPayload(
      input({
        findings: [
          line({ severity: "HIGH" }),
          line({ severity: "MEDIUM", ruleCode: "R003" }),
          line({ severity: "MEDIUM", ruleCode: "R004" }),
          line({ severity: "LOW", ruleCode: "R012" }),
        ],
      }),
    );
    expect(payload.summary).toMatchObject({ total: 4, high: 1, medium: 2, low: 1 });
  });

  it("状態ごとに数える", () => {
    const payload = buildAuditReportPayload(
      input({
        findings: [
          line({ status: "OPEN" }),
          line({ status: "REVIEWING", ruleCode: "R003" }),
          line({ status: "RESOLVED", ruleCode: "R004" }),
          line({ status: "FALSE_POSITIVE", ruleCode: "R005" }),
        ],
      }),
    );
    expect(payload.summary).toMatchObject({ open: 2, resolved: 1, dismissed: 1 });
  });

  it("抑制の件数は入力のまま（差異の表からは数えられない）", () => {
    expect(buildAuditReportPayload(input({ suppressedCount: 6 })).summary.suppressed).toBe(6);
  });

  it("差異が 0 件でも組み立てられる", () => {
    const payload = buildAuditReportPayload(input());
    expect(payload.summary.total).toBe(0);
    expect(payload.highFindings).toEqual([]);
  });

  it("評価対象客室日数と系統をそのまま載せる", () => {
    const payload = buildAuditReportPayload(input());
    expect(payload.summary.roomDays).toBe(1800);
    expect(payload.summary.availableSources).toEqual(["occupancy", "observation"]);
  });
});

describe("節ごとの絞り込み（§7.1 の 3. と 4.）", () => {
  it("3. は重要度 高 の全件", () => {
    const payload = buildAuditReportPayload(
      input({
        findings: [line({ severity: "HIGH" }), line({ severity: "LOW", ruleCode: "R012" })],
      }),
    );
    expect(payload.highFindings).toHaveLength(1);
    expect(payload.highFindings[0]?.severity).toBe("HIGH");
  });

  it("4. は未対応（OPEN / REVIEWING）だけ", () => {
    const payload = buildAuditReportPayload(
      input({
        findings: [
          line({ status: "OPEN" }),
          line({ status: "REVIEWING", ruleCode: "R003" }),
          line({ status: "RESOLVED", ruleCode: "R004" }),
        ],
      }),
    );
    expect(payload.openFindings).toHaveLength(2);
  });

  it("**解決済みの HIGH は 3. に残る**（対応の記録として）", () => {
    const payload = buildAuditReportPayload(
      input({ findings: [line({ severity: "HIGH", status: "RESOLVED" })] }),
    );
    expect(payload.highFindings).toHaveLength(1);
    expect(payload.openFindings).toEqual([]);
  });

  it("並びが決まっている（新しい順・重要度順・部屋番号順）", () => {
    const payload = buildAuditReportPayload(
      input({
        findings: [
          line({ businessDate: "2026-09-01", roomNumber: "101" }),
          line({ businessDate: "2026-09-09", roomNumber: "302" }),
          line({ businessDate: "2026-09-09", roomNumber: "208" }),
        ],
      }),
    );
    expect(payload.highFindings.map((row) => `${row.businessDate}/${row.roomNumber}`)).toEqual([
      "2026-09-09/208",
      "2026-09-09/302",
      "2026-09-01/101",
    ]);
  });

  it("入力の配列を書き換えない", () => {
    const findings = [line({ businessDate: "2026-09-01" }), line({ businessDate: "2026-09-09" })];
    buildAuditReportPayload(input({ findings }));
    expect(findings[0]?.businessDate).toBe("2026-09-01");
  });
});

describe("buildRuleLines — ルール別（§7.1 の 5.）", () => {
  const titleOf = (code: string) => `${code} の名称`;

  it("ルールごとに件数を数える", () => {
    const rules = buildRuleLines(
      [line({ ruleCode: "R001" }), line({ ruleCode: "R001" }), line({ ruleCode: "R003" })],
      titleOf,
    );
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ ruleCode: "R001", total: 2 });
  });

  it("対象外として閉じた割合を千分率で出す", () => {
    const rules = buildRuleLines(
      [
        line({ ruleCode: "R001", status: "FALSE_POSITIVE" }),
        line({ ruleCode: "R001", status: "RESOLVED" }),
        line({ ruleCode: "R001", status: "OPEN" }),
        line({ ruleCode: "R001", status: "OPEN" }),
      ],
      titleOf,
    );
    expect(rules[0]?.dismissedPermille).toBe(250);
  });

  it("コード順に並ぶ（件数順にしない）", () => {
    const rules = buildRuleLines(
      [line({ ruleCode: "R013" }), line({ ruleCode: "R001" }), line({ ruleCode: "R001" })],
      titleOf,
    );
    expect(rules.map((row) => row.ruleCode)).toEqual(["R001", "R013"]);
  });

  it("名称は渡された関数から引く（写経しない）", () => {
    expect(buildRuleLines([line({ ruleCode: "R001" })], titleOf)[0]?.title).toBe("R001 の名称");
  });

  it("差異が無ければ空", () => {
    expect(buildRuleLines([], titleOf)).toEqual([]);
  });
});
