/**
 * 月次監査レポート PDF のテンプレートの検査（PK-SPEC-P4 §7）。
 *
 * task: docs/tasks/P4-14.md
 *
 * ── CI に和文フォントを置いていない ─────────────────────
 * `BUILT_IN_LATIN`（Helvetica）で描画する。日報の spec と同じ理由
 * （`dailyReport.spec.ts` 冒頭）。
 *
 * ── いちばん大事な検査 ──────────────────────────────────
 * §7.2 MUST「免責文を削除・編集できない実装にする」。
 * **payload に別の文言を入れても、出力には定数が載る。**
 */

import {
  AUDIT_REPORT_DISCLAIMER,
  buildAuditReportPayload,
  type AuditReportInput,
  type AuditReportPayload,
} from "@pk/engine";
import { describe, expect, it } from "vitest";

import { buildAuditReportDocument, type AuditReportFont } from "./auditReport.js";
import { AUDIT_REPORT_LABELS } from "./labels.js";
import { renderAuditReportPdf } from "./render.js";

const LATIN: AuditReportFont = { kind: "BUILT_IN_LATIN" };

function input(overrides: Partial<AuditReportInput> = {}): AuditReportInput {
  return {
    property: { id: "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH", name: "Sample Hotel" },
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

function payloadWith(findings: number): AuditReportPayload {
  return buildAuditReportPayload(
    input({
      findings: Array.from({ length: findings }, (_unused, index) => ({
        businessDate: "2026-09-09",
        roomNumber: String(300 + index),
        ruleCode: "R001",
        severity: "HIGH" as const,
        confidence: 80,
        title: "Room usage without occupancy record",
        status: "OPEN",
        resolutionCode: null,
      })),
      trend: Array.from({ length: 12 }, (_unused, index) => ({
        month: `2026-${String(index + 1).padStart(2, "0")}`,
        high: index,
        medium: index * 2,
        low: index * 3,
      })),
    }),
  );
}

/** 描画された要素を平坦に集める。**行数を数えるためだけ。** */
function flatten(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") return [];
  const element = node as { props?: { children?: unknown } };
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return [node, ...list.flatMap(flatten)];
}

/** 描画された要素に含まれる文字列。 */
function texts(node: unknown): string[] {
  return flatten(node).flatMap((element) => {
    const children = (element as { props?: { children?: unknown } }).props?.children;
    return typeof children === "string" ? [children] : [];
  });
}

describe("免責事項（§7.2 MUST）", () => {
  it("出力に全文が載る", () => {
    const document = buildAuditReportDocument(payloadWith(0), LATIN);
    expect(texts(document)).toContain(AUDIT_REPORT_DISCLAIMER);
  });

  it("**payload を書き換えても定数が載る**（差し替えられない）", () => {
    const payload = { ...payloadWith(0), disclaimer: "書き換えた文言" };
    const document = buildAuditReportDocument(payload, LATIN);
    const output = texts(document);
    expect(output).toContain(AUDIT_REPORT_DISCLAIMER);
    expect(output).not.toContain("書き換えた文言");
  });

  it("差異が 0 件でも免責文は出る", () => {
    expect(texts(buildAuditReportDocument(payloadWith(0), LATIN))).toContain(
      AUDIT_REPORT_DISCLAIMER,
    );
  });
});

describe("6 セクション（§7.1）", () => {
  it("節の見出しが 6 つとも出る", () => {
    const output = texts(buildAuditReportDocument(payloadWith(3), LATIN));
    for (const title of [
      AUDIT_REPORT_LABELS.section1,
      AUDIT_REPORT_LABELS.section2,
      AUDIT_REPORT_LABELS.section3,
      AUDIT_REPORT_LABELS.section4,
      AUDIT_REPORT_LABELS.section5,
      AUDIT_REPORT_LABELS.section6,
    ]) {
      expect(output, title).toContain(title);
    }
  });

  it("**該当が無い節も見出しごと残る**（「該当なし」を出す）", () => {
    const output = texts(buildAuditReportDocument(payloadWith(0), LATIN));
    expect(output).toContain(AUDIT_REPORT_LABELS.section3);
    expect(output).toContain(AUDIT_REPORT_LABELS.none);
  });

  it("表題と施設名が出る", () => {
    const output = texts(buildAuditReportDocument(payloadWith(1), LATIN));
    expect(output).toContain(AUDIT_REPORT_LABELS.title);
    expect(output).toContain("Sample Hotel");
  });

  it("エンジン版とルールセットの指紋が出る", () => {
    expect(texts(buildAuditReportDocument(payloadWith(1), LATIN))).toContain("1.1 / a3f9c2");
  });

  it("12 か月の推移がすべて行になる", () => {
    const output = texts(buildAuditReportDocument(payloadWith(1), LATIN));
    for (let month = 1; month <= 12; month += 1) {
      expect(output).toContain(`2026-${String(month).padStart(2, "0")}`);
    }
  });
});

describe("禁止語（ui-writing.md §2 / §10.5）", () => {
  it("「不正」「検知」「監視」「疑わしい」が 1 つも出ない", () => {
    // **免責文だけは「不正行為」を含む**（§7.2 の全文固定）。それ以外の
    // 文言に禁止語が混ざっていないことを見る。
    const output = texts(buildAuditReportDocument(payloadWith(3), LATIN)).filter(
      (text) => text !== AUDIT_REPORT_DISCLAIMER,
    );
    for (const word of ["不正", "検知", "監視", "疑わしい", "異常"]) {
      expect(output.filter((text) => text.includes(word)), word).toEqual([]);
    }
  });
});

describe("描画", () => {
  it("PDF のバイト列になる", async () => {
    const bytes = await renderAuditReportPdf(payloadWith(2), LATIN);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // PDF のマジックナンバー（`%PDF`）。
    expect([...bytes.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("差異が 0 件でも描画できる", async () => {
    const bytes = await renderAuditReportPdf(payloadWith(0), LATIN);
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
