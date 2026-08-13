/**
 * 集計ウィンドウのテスト（PK-SPEC-P3 §5.4）。
 *
 * task: docs/tasks/P3-09.md
 */

import { describe, expect, it } from "vitest";

import {
  BASELINE_CHUNK_DAYS,
  DEFAULT_BASELINE_WINDOW_DAYS,
  MAX_BASELINE_WINDOW_DAYS,
  MIN_BASELINE_WINDOW_DAYS,
  baselineWindowOf,
  businessDateChunks,
} from "./window.js";

describe("baselineWindowOf", () => {
  it("既定は 90 日で、終端を含む", () => {
    const window = baselineWindowOf("2026-09-12", DEFAULT_BASELINE_WINDOW_DAYS);
    expect(window).toEqual({ from: "2026-06-15", to: "2026-09-12", days: 90 });
  });

  it("最小（30 日）と最大（365 日）はそのまま通る", () => {
    expect(baselineWindowOf("2026-09-12", MIN_BASELINE_WINDOW_DAYS).days).toBe(30);
    expect(baselineWindowOf("2026-09-12", MAX_BASELINE_WINDOW_DAYS).days).toBe(365);
  });

  it("範囲外の日数は既定へ寄せる（例外にしない）", () => {
    expect(baselineWindowOf("2026-09-12", 7).days).toBe(DEFAULT_BASELINE_WINDOW_DAYS);
    expect(baselineWindowOf("2026-09-12", 1000).days).toBe(DEFAULT_BASELINE_WINDOW_DAYS);
    expect(baselineWindowOf("2026-09-12", 90.5).days).toBe(DEFAULT_BASELINE_WINDOW_DAYS);
  });

  it("うるう年の 2 月をまたいでも日数が合う", () => {
    const window = baselineWindowOf("2028-03-01", 30);
    expect(window.from).toBe("2028-02-01");
  });
});

describe("businessDateChunks", () => {
  it("隣り合う区間が重ならず、隙間もない", () => {
    const window = baselineWindowOf("2026-09-12", 90);
    const chunks = businessDateChunks(window);
    expect(chunks[0]?.from).toBe(window.from);
    expect(chunks.at(-1)?.to).toBe(window.to);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1];
      const current = chunks[index];
      expect(previous?.to).toBeDefined();
      expect(current?.from).toBeDefined();
      // 前の区間の終端 < 今の区間の始端（辞書順 = 日付順）。
      expect((previous?.to ?? "") < (current?.from ?? "")).toBe(true);
    }
  });

  it("既定の幅で 90 日は 6 区間になる", () => {
    expect(businessDateChunks(baselineWindowOf("2026-09-12", 90))).toHaveLength(
      90 / BASELINE_CHUNK_DAYS,
    );
  });

  it("端数が出ても最後の区間が終端で止まる", () => {
    const window = baselineWindowOf("2026-09-12", 100);
    const chunks = businessDateChunks(window);
    expect(chunks).toHaveLength(7);
    expect(chunks.at(-1)?.to).toBe("2026-09-12");
  });

  it("1 日ぶんの窓は 1 区間", () => {
    expect(businessDateChunks({ from: "2026-09-12", to: "2026-09-12", days: 1 })).toEqual([
      { from: "2026-09-12", to: "2026-09-12" },
    ]);
  });

  it("壊れた幅は既定へ寄せる（0 で無限ループにしない）", () => {
    const window = baselineWindowOf("2026-09-12", 30);
    expect(businessDateChunks(window, 0)).toHaveLength(2);
    expect(businessDateChunks(window, -5)).toHaveLength(2);
  });
});
