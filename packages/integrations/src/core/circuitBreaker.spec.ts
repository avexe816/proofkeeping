/**
 * リトライとサーキットブレーカー（P6-07 / PK-SPEC-P6 §3.4）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  CIRCUIT_OPEN_THRESHOLD,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAYS_MINUTES,
  canRunScheduledSync,
  circuitStateOf,
  retryDelaySeconds,
  shouldOpenCircuit,
  shouldRetry,
} from "./circuitBreaker.js";

describe("retryDelaySeconds — 正例（再試行する）", () => {
  it("1 回目の失敗は 5 分後", () => {
    expect(retryDelaySeconds(1)).toBe(5 * 60);
  });

  it("2 回目の失敗は 15 分後", () => {
    expect(retryDelaySeconds(2)).toBe(15 * 60);
  });

  it("3 回目の失敗は 60 分後", () => {
    expect(retryDelaySeconds(3)).toBe(60 * 60);
  });

  it("0 以下は 1 回目として扱う", () => {
    expect(retryDelaySeconds(0)).toBe(5 * 60);
    expect(retryDelaySeconds(-3)).toBe(5 * 60);
  });

  it("仕様の 3 段（5 / 15 / 60 分）をそのまま持つ", () => {
    expect(RETRY_DELAYS_MINUTES).toEqual([5, 15, 60]);
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
  });
});

describe("retryDelaySeconds — 負例（打ち止め）", () => {
  it("4 回目は再試行しない", () => {
    expect(retryDelaySeconds(4)).toBeNull();
    expect(shouldRetry(4)).toBe(false);
  });

  it("10 回目も再試行しない", () => {
    expect(retryDelaySeconds(10)).toBeNull();
  });

  it("3 回目までは再試行する", () => {
    expect(shouldRetry(1)).toBe(true);
    expect(shouldRetry(2)).toBe(true);
    expect(shouldRetry(3)).toBe(true);
  });

  it("小数は切り捨てて数える", () => {
    expect(retryDelaySeconds(2.9)).toBe(15 * 60);
  });

  it("遅延は必ず増える方向（縮まない）", () => {
    const delays = [1, 2, 3].map((attempt) => retryDelaySeconds(attempt) ?? 0);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });
});

describe("shouldOpenCircuit（§3.4 の 5 回）", () => {
  it("5 回連続失敗で開く", () => {
    expect(shouldOpenCircuit(CIRCUIT_OPEN_THRESHOLD)).toBe(true);
  });

  it("6 回でも開く（取りこぼさない）", () => {
    expect(shouldOpenCircuit(6)).toBe(true);
  });

  it("4 回では開かない", () => {
    expect(shouldOpenCircuit(4)).toBe(false);
  });

  it("0 回では開かない", () => {
    expect(shouldOpenCircuit(0)).toBe(false);
  });

  it("閾値は 5", () => {
    expect(CIRCUIT_OPEN_THRESHOLD).toBe(5);
  });
});

describe("circuitStateOf / canRunScheduledSync", () => {
  it("ERROR は開いている", () => {
    expect(circuitStateOf("ERROR")).toBe("OPEN");
  });

  it("ACTIVE は閉じている", () => {
    expect(circuitStateOf("ACTIVE")).toBe("CLOSED");
  });

  it("ACTIVE のときだけ定期同期を走らせる", () => {
    expect(canRunScheduledSync("ACTIVE")).toBe(true);
  });

  it.each(["ERROR", "SUSPENDED", "INACTIVE", "CONNECTING"])(
    "%s では定期同期を走らせない",
    (status) => {
      expect(canRunScheduledSync(status)).toBe(false);
    },
  );

  it("知らない状態は閉じている扱い（自動同期はしない）", () => {
    expect(circuitStateOf("WHATEVER")).toBe("CLOSED");
    expect(canRunScheduledSync("WHATEVER")).toBe(false);
  });
});
