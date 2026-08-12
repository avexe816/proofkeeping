/**
 * 書類番号と会計年度の検査。
 *
 * task:  docs/tasks/P0-17.md
 * ルール: .claude/rules/testing.md §3（純粋関数は正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  documentSequencerName,
  fiscalYearOf,
  formatDocumentNumber,
} from "./documentNumber.js";

describe("formatDocumentNumber", () => {
  it.each([
    ["INVOICE", 2026, 42, "INV-2026-0042"],
    ["INVOICE", 2026, 1, "INV-2026-0001"],
    ["RECEIPT", 2026, 18, "RCP-2026-0018"],
    ["REPORT", 2025, 9999, "RPT-2025-9999"],
    ["INVOICE", 2030, 7, "INV-2030-0007"],
  ] as const)("%s / %i / %i → %s", (type, year, sequence, expected) => {
    expect(formatDocumentNumber(type, year, sequence)).toBe(expected);
  });

  it("9999 の次は桁が増える。0000 へ折り返さない", () => {
    expect(formatDocumentNumber("INVOICE", 2026, 10_000)).toBe("INV-2026-10000");
  });

  it.each([
    ["連番 0", 2026, 0],
    ["連番が負", 2026, -1],
    ["連番が小数", 2026, 1.5],
    ["年が 3 桁", 999, 1],
    ["年が 5 桁", 10_000, 1],
    ["年が小数", 2026.5, 1],
  ])("%s は落ちる", (_label, year, sequence) => {
    expect(() => formatDocumentNumber("INVOICE", year, sequence)).toThrow();
  });
});

describe("fiscalYearOf", () => {
  it.each([
    // 開始月 4（既定）
    ["2026-04-01", 4, 2026],
    ["2026-03-31", 4, 2025],
    ["2026-12-31", 4, 2026],
    ["2026-01-01", 4, 2025],
    // 開始月 1（暦年と一致）
    ["2026-01-01", 1, 2026],
    ["2026-12-31", 1, 2026],
    // 開始月 10
    ["2026-09-30", 10, 2025],
    ["2026-10-01", 10, 2026],
  ])("%s / 開始月 %i → %i 年度", (date, startMonth, expected) => {
    expect(fiscalYearOf(date, startMonth)).toBe(expected);
  });

  it("同じ西暦でも年度をまたぐと値が変わる（連番のリセット境界）", () => {
    expect(fiscalYearOf("2026-03-31", 4)).not.toBe(fiscalYearOf("2026-04-01", 4));
  });

  it.each([
    ["開始月 0", "2026-04-01", 0],
    ["開始月 13", "2026-04-01", 13],
    ["開始月が小数", "2026-04-01", 4.5],
    ["日付の形が違う", "2026/04/01", 4],
    ["日付が短い", "2026-4-1", 4],
    ["月が 13", "2026-13-01", 4],
    ["日が 0", "2026-04-00", 4],
    ["空文字", "", 4],
  ])("%s は落ちる", (_label, date, startMonth) => {
    expect(() => fiscalYearOf(date, startMonth)).toThrow();
  });
});

describe("documentSequencerName", () => {
  it("組織 × 文書種別 × 年度で 1 インスタンス", () => {
    expect(documentSequencerName("o7k2m9__org_1", "INVOICE", 2026)).toBe(
      "o7k2m9__org_1|INVOICE|2026",
    );
  });

  it.each([
    ["組織が違う", "o7k2m9__org_1", "aaaaaa__org_1", "INVOICE", "INVOICE", 2026, 2026],
    ["種別が違う", "o7k2m9__org_1", "o7k2m9__org_1", "INVOICE", "RECEIPT", 2026, 2026],
    ["年度が違う", "o7k2m9__org_1", "o7k2m9__org_1", "INVOICE", "INVOICE", 2026, 2025],
  ] as const)("%s なら別インスタンス", (_l, orgA, orgB, typeA, typeB, yearA, yearB) => {
    expect(documentSequencerName(orgA, typeA, yearA)).not.toBe(
      documentSequencerName(orgB, typeB, yearB),
    );
  });
});
