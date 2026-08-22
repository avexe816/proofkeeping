/**
 * 同梱した和文書体（`font.ts`）。
 *
 * ここが守るのは 1 つ。**帳票に出る日本語が、実際に字として出ること。**
 *
 * ── なぜ「読める」を機械で見るのか ──────────────────────
 * `@react-pdf/renderer` は、書体にグリフが無い文字を**例外にしない。**
 * 空白のまま描いて PDF を作り終える。つまり「動いているのに読めない
 * PDF」が、誰も気づかないまま取引先へ送られうる（`packages/pdf/src/
 * dailyReport.ts` の注記 / OPEN_QUESTIONS #054）。書体を差し替えるとき、
 * ここが落ちれば気づける。
 */

import {
  AUDIT_REPORT_LABELS,
  DAILY_REPORT_LABELS,
  INVOICE_LABELS,
  PAYOUT_LABELS,
  RECEIPT_LABELS,
} from "@pk/pdf";
import { describe, expect, it } from "vitest";

import { DAILY_REPORT_FONT_FAMILY, dailyReportFont } from "./font.js";

/** data URL からバイト列へ戻す。 */
function fontBytes(): Uint8Array {
  const font = dailyReportFont();
  if (font.kind !== "EMBEDDED") throw new Error("EMBEDDED ではない");
  const base64 = font.dataUrl.slice(font.dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 帳票に出うる日本語をすべて集める（重複は落とす）。 */
function labelText(): string {
  const sets: unknown[] = [
    DAILY_REPORT_LABELS,
    AUDIT_REPORT_LABELS,
    INVOICE_LABELS,
    RECEIPT_LABELS,
    PAYOUT_LABELS,
  ];
  const collected: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") collected.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  sets.forEach(walk);
  return collected.join("");
}

describe("同梱した和文書体", () => {
  it("data URL の形で持っている（`?url` へ変えると実行時に落ちる枝へ入る）", () => {
    const font = dailyReportFont();
    expect(font.kind).toBe("EMBEDDED");
    if (font.kind !== "EMBEDDED") return;
    expect(font.family).toBe(DAILY_REPORT_FONT_FAMILY);
    expect(font.dataUrl.startsWith("data:font/ttf;base64,")).toBe(true);
  });

  it("TrueType の実体になっている", () => {
    const bytes = fontBytes();
    // sfnt バージョン 0x00010000（TrueType のアウトライン）。
    expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
    // 数 MB あること。**取り違えて 0 バイトを同梱していないか。**
    expect(bytes.byteLength).toBeGreaterThan(1_000_000);
  });

  it("**帳票の文言に出る文字をすべて持っている**", () => {
    const cmap = readCmap(fontBytes());

    const missing = [...new Set(labelText())]
      .filter((char) => char.trim() !== "")
      // 対応が無い符号位置は `.notdef` になり、**その字は白いまま PDF に出る。**
      .filter((char) => cmap(char.codePointAt(0) ?? 0) === 0);

    expect(missing, `グリフの無い文字: ${missing.join("")}`).toEqual([]);
  });

  it("**持っていない字は 0 と答える**（この検査に歯があること）", () => {
    const cmap = readCmap(fontBytes());
    // 絵文字は IPAゴシックに無い。ここが 0 以外を返すなら読み方が誤っている。
    expect(cmap(0x1f427)).toBe(0);
    // 逆に、ごく普通の漢字は必ず在る。
    expect(cmap("清".codePointAt(0) ?? 0)).not.toBe(0);
  });

  it("参照するたびに作り直さない（8MB の文字列を複製しない）", () => {
    expect(dailyReportFont()).toBe(dailyReportFont());
  });
});

// ────────────────────────────────────────────────────────────
// cmap の読み取り（テスト専用）
// ────────────────────────────────────────────────────────────
//
// **依存を足していない。** `fontkit` は `apps/web` の直接の依存ではなく、
// この 1 つの検査のために増やすと供給網が広がる（`lib/qr` を自前で
// 書いたのと同じ判断）。必要なのは「符号位置 → グリフ番号」だけなので、
// Unicode の cmap（形式 4 と形式 12）だけを読む。

/** 符号位置からグリフ番号を引く関数を作る。**引けなければ 0**（`.notdef`）。 */
function readCmap(font: Uint8Array): (codePoint: number) => number {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tableCount = view.getUint16(4);

  let cmapOffset = -1;
  for (let i = 0; i < tableCount; i += 1) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(...font.subarray(record, record + 4));
    if (tag === "cmap") cmapOffset = view.getUint32(record + 8);
  }
  if (cmapOffset < 0) throw new Error("cmap が無い");

  // Unicode のサブテーブルを選ぶ。形式 12（面をまたぐ）を優先する。
  const encodingCount = view.getUint16(cmapOffset + 2);
  let best = -1;
  let bestFormat = -1;
  for (let i = 0; i < encodingCount; i += 1) {
    const record = cmapOffset + 4 + i * 8;
    const platformId = view.getUint16(record);
    const encodingId = view.getUint16(record + 2);
    const subtable = cmapOffset + view.getUint32(record + 4);
    const unicode =
      platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!unicode) continue;
    const format = view.getUint16(subtable);
    if ((format === 4 || format === 12) && format > bestFormat) {
      best = subtable;
      bestFormat = format;
    }
  }
  if (best < 0) throw new Error("Unicode の cmap が無い");

  return bestFormat === 12 ? format12(view, best) : format4(view, best);
}

/** 形式 4（BMP・区間ごとの差分）。 */
function format4(view: DataView, offset: number): (codePoint: number) => number {
  const segCount = view.getUint16(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segCount * 2 + 2;
  const deltas = starts + segCount * 2;
  const ranges = deltas + segCount * 2;

  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let i = 0; i < segCount; i += 1) {
      if (view.getUint16(ends + i * 2) < codePoint) continue;
      if (view.getUint16(starts + i * 2) > codePoint) return 0;
      const rangeOffset = view.getUint16(ranges + i * 2);
      if (rangeOffset === 0) {
        return (codePoint + view.getInt16(deltas + i * 2)) & 0xffff;
      }
      const at =
        ranges + i * 2 + rangeOffset + (codePoint - view.getUint16(starts + i * 2)) * 2;
      const glyph = view.getUint16(at);
      return glyph === 0 ? 0 : (glyph + view.getInt16(deltas + i * 2)) & 0xffff;
    }
    return 0;
  };
}

/** 形式 12（面をまたぐ・区間の並び）。 */
function format12(view: DataView, offset: number): (codePoint: number) => number {
  const groupCount = view.getUint32(offset + 12);
  return (codePoint) => {
    for (let i = 0; i < groupCount; i += 1) {
      const group = offset + 16 + i * 12;
      const start = view.getUint32(group);
      if (start > codePoint) return 0;
      if (view.getUint32(group + 4) < codePoint) continue;
      return view.getUint32(group + 8) + (codePoint - start);
    }
    return 0;
  };
}
