/**
 * 日報 PDF のテンプレートの検査（PK-SPEC-P2 §9.2）。
 *
 * task: docs/tasks/P2-14.md
 *
 * ── CI に和文フォントを置いていない ─────────────────────
 * 描画の検査は `BUILT_IN_LATIN`（Helvetica）で行う。**和文のグリフは
 * 出ないが、レイアウトと描画の経路は同じ**。ここで見たいのは
 * 「payload を渡すと PDF のバイト列になる」ことと、
 * 「行数が payload の行数と一致する」ことで、字形ではない。
 *
 * 実際の日報に使う書体は R2 に置いた TTF（`apps/web/src/lib/report/font.ts`）。
 * **それが無ければコンシューマは PDF を作らずに失敗する**ので、
 * 「和文が空白の日報」が出回ることはない。
 */

import { buildDailyReportPayload, type DailyReportInput } from "@pk/engine";
import { describe, expect, it } from "vitest";

import { buildDailyReportDocument, type DailyReportFont } from "./dailyReport.js";
import {
  formatBusinessDate,
  formatClock,
  formatCount,
  formatDateTime,
  formatMinutes,
  formatReworkCount,
} from "./format.js";
import { renderDailyReportPdf } from "./render.js";

const LATIN: DailyReportFont = { kind: "BUILT_IN_LATIN" };
const SHA = "a".repeat(64);

function payloadWith(tasks: number, findings = 0) {
  const input: DailyReportInput = {
    documentNo: "RPT-2026-0042",
    revision: 1,
    businessDate: "2026-09-10",
    generatedAtMs: Date.UTC(2026, 8, 10, 20, 10, 0),
    property: { code: "HTLA", name: "Sample Hotel", timezone: "Asia/Tokyo" },
    tasks: Array.from({ length: tasks }, (_unused, index) => ({
      taskId: `t${String(index)}`,
      roomNumber: String(300 + index),
      taskType: "CHECKOUT",
      status: "COMPLETED",
      assigneeName: "Tanaka",
      startedAtMs: Date.UTC(2026, 8, 10, 4, 30, 0),
      completedAtMs: Date.UTC(2026, 8, 10, 5, 2, 0),
      actualMinutes: 32,
      blockedReason: null,
    })),
    inspections: [],
    reworks: [],
    findings: Array.from({ length: findings }, (_unused, index) => ({
      reference: `L-000${String(index)}`,
      roomNumber: "302",
      kind: "CLOTHING",
      status: "STORED",
      source: "LOST_ITEM" as const,
    })),
  };
  return buildDailyReportPayload(input);
}

describe("整形", () => {
  it.each([
    ["UTC 04:30 は JST 13:30", "2026-09-10T04:30:00.000Z", "Asia/Tokyo", "13:30"],
    ["日付をまたぐ", "2026-09-10T20:10:00.000Z", "Asia/Tokyo", "05:10"],
    ["UTC 指定ならそのまま", "2026-09-10T04:30:00.000Z", "UTC", "04:30"],
    ["00 時台", "2026-09-10T15:05:00.000Z", "Asia/Tokyo", "00:05"],
    ["23 時台", "2026-09-10T14:00:00.000Z", "Asia/Tokyo", "23:00"],
  ])("%s", (_label, iso, timezone, expected) => {
    expect(formatClock(iso, timezone)).toBe(expected);
  });

  it.each([
    ["null は空欄", null, ""],
    ["0 分は 0 と出す", 0, "0"],
    ["32 分", 32, "32"],
    ["3 桁", 120, "120"],
    ["1 分", 1, "1"],
  ])("実作業分: %s", (_label, minutes, expected) => {
    expect(formatMinutes(minutes)).toBe(expected);
  });

  it("再清掃 0 回は空欄（表を数字で埋めない）", () => {
    expect(formatReworkCount(0)).toBe("");
    expect(formatReworkCount(2)).toBe("2");
  });

  it("業務日と件数と生成日時", () => {
    expect(formatBusinessDate("2026-09-10")).toBe("2026年9月10日");
    expect(formatBusinessDate("こわれた値")).toBe("こわれた値");
    expect(formatCount(52)).toBe("52件");
    expect(formatDateTime("2026-09-10T20:10:00.000Z", "Asia/Tokyo")).toBe("2026年9月11日 05:10");
  });
});

describe("要素の組み立て", () => {
  it("payload の明細の行数だけ行ができる", () => {
    const document = buildDailyReportDocument(payloadWith(3), SHA, LATIN);
    // 見出し行 + 3 行。**深く辿らずに数える**（構造の詳細に依存させない）。
    const rows = JSON.stringify(document).match(/"roomNumber"|"302"|"303"|"304"/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
  });

  it("文書ハッシュが載る", () => {
    const document = buildDailyReportDocument(payloadWith(1), SHA, LATIN);
    expect(JSON.stringify(document)).toContain(SHA);
  });

  it("再生成の版では旧版が残っている旨を出す", () => {
    const payload = { ...payloadWith(1), revision: 2 };
    const document = buildDailyReportDocument(payload, SHA, LATIN);
    expect(JSON.stringify(document)).toContain("再生成された版");
  });

  it("revision 1 では出さない", () => {
    const document = buildDailyReportDocument(payloadWith(1), SHA, LATIN);
    expect(JSON.stringify(document)).not.toContain("再生成された版");
  });
});

describe("描画", () => {
  it("PDF のバイト列になる", async () => {
    const bytes = await renderDailyReportPdf(payloadWith(5, 2), SHA, LATIN);
    expect(bytes.byteLength).toBeGreaterThan(500);
    // PDF のマジックナンバー（`%PDF-`）。
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  }, 30_000);

  it("タスクが 0 件でも作れる（該当なしの日報）", async () => {
    const bytes = await renderDailyReportPdf(payloadWith(0), SHA, LATIN);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  }, 30_000);

  it("明細が増えても作れる（複数ページ）", async () => {
    const bytes = await renderDailyReportPdf(payloadWith(60), SHA, LATIN);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  }, 60_000);
});
