/**
 * 月次監査レポートの配線（P4-14 / PK-SPEC-P4 §7）。
 *
 * ルール: .claude/rules/testing.md §4（冪等）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - メッセージの形（`pdf-generation` に 2 種類が載る）
 *   - **R2 のキーが `(組織, 施設, 月)` で決まる**（版を持たない / 冪等）
 *   - 12 か月の並びが年をまたいでも崩れない
 */

import { describe, expect, it } from "vitest";

import { isAuditReportMessage, type AuditReportMessage } from "./auditReport.js";
import { isDailyReportMessage } from "./dailyReport.js";
import {
  TREND_MONTHS,
  auditReportKey,
  previousMonthOf,
  trendMonthsOf,
} from "../lib/report/auditReport.js";

const MESSAGE: AuditReportMessage = {
  kind: "AUDIT_REPORT",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  propertyId: "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6",
  month: "2026-09",
  requestedById: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR6",
  requestedAtMs: Date.UTC(2026, 9, 1, 0, 0, 0),
};

describe("isAuditReportMessage", () => {
  it("正しい形を通す", () => {
    expect(isAuditReportMessage(MESSAGE)).toBe(true);
  });

  it("`kind` が違えば偽", () => {
    expect(isAuditReportMessage({ ...MESSAGE, kind: "DAILY_REPORT" })).toBe(false);
  });

  it("月が無ければ偽", () => {
    const rest: Record<string, unknown> = { ...MESSAGE };
    delete rest["month"];
    expect(isAuditReportMessage(rest)).toBe(false);
  });

  it("`null` / 文字列は偽", () => {
    expect(isAuditReportMessage(null)).toBe(false);
    expect(isAuditReportMessage("AUDIT_REPORT")).toBe(false);
  });

  it("**日報のメッセージと取り違えない**（1 本のキューに 2 種類が載る）", () => {
    expect(isDailyReportMessage(MESSAGE)).toBe(false);
    expect(isAuditReportMessage(MESSAGE)).toBe(true);
  });
});

describe("auditReportKey — 版を持たない（DECISIONS #119）", () => {
  it("組織・施設・月で決まる", () => {
    expect(
      auditReportKey({ organizationId: "org1", propertyId: "prop1", month: "2026-09" }),
    ).toBe("audit-reports/org1/prop1/2026-09.pdf");
  });

  it("**同じ入力なら同じキー**（3 回作っても増えない）", () => {
    const input = { organizationId: "org1", propertyId: "prop1", month: "2026-09" };
    expect(auditReportKey(input)).toBe(auditReportKey(input));
  });

  it("月が違えば別のキー", () => {
    expect(
      auditReportKey({ organizationId: "org1", propertyId: "prop1", month: "2026-08" }),
    ).not.toBe(auditReportKey({ organizationId: "org1", propertyId: "prop1", month: "2026-09" }));
  });

  it("施設が違えば別のキー", () => {
    expect(
      auditReportKey({ organizationId: "org1", propertyId: "prop2", month: "2026-09" }),
    ).not.toBe(auditReportKey({ organizationId: "org1", propertyId: "prop1", month: "2026-09" }));
  });
});

describe("trendMonthsOf — 12 か月の並び（§7.1 の 2.）", () => {
  it("12 か月ぶん返る", () => {
    expect(trendMonthsOf("2026-09")).toHaveLength(TREND_MONTHS);
  });

  it("**古い順**（表は左から右へ時間が進む）", () => {
    const months = trendMonthsOf("2026-09");
    expect(months[0]).toBe("2025-10");
    expect(months[months.length - 1]).toBe("2026-09");
  });

  it("年をまたいでも崩れない", () => {
    const months = trendMonthsOf("2026-02", 4);
    expect(months).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("1 月から遡ると前年の 12 月へ", () => {
    expect(trendMonthsOf("2026-01", 2)).toEqual(["2025-12", "2026-01"]);
  });

  it("形が違えば空", () => {
    expect(trendMonthsOf("2026")).toEqual([]);
    expect(trendMonthsOf("")).toEqual([]);
  });
});

describe("previousMonthOf", () => {
  it("前月を返す", () => {
    expect(previousMonthOf("2026-09-15")).toBe("2026-08");
  });

  it("年をまたぐ", () => {
    expect(previousMonthOf("2026-01-05")).toBe("2025-12");
  });
});
