/**
 * 送信 Webhook の配信規則（P6-13 / PK-SPEC-P6 §6.4）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  OUTBOUND_DISABLE_THRESHOLD,
  OUTBOUND_EVENT_VALUES,
  OUTBOUND_MAX_ATTEMPTS,
  OUTBOUND_RETRY_DELAYS_MINUTES,
  isDeliverySuccess,
  outboundRetryDelaySeconds,
  shouldDisableOutbound,
  subscribesTo,
} from "./outboundDelivery.js";
import { RETRY_DELAYS_MINUTES } from "./circuitBreaker.js";

describe("outboundRetryDelaySeconds — 正例（再送する）", () => {
  it.each([
    [1, 60],
    [2, 5 * 60],
    [3, 30 * 60],
    [4, 2 * 60 * 60],
    [5, 6 * 60 * 60],
  ])("%i 回目の失敗は %i 秒後", (attempt, expected) => {
    expect(outboundRetryDelaySeconds(attempt)).toBe(expected);
  });

  it("§6.4 の 5 段（1 / 5 / 30 分・2 / 6 時間）をそのまま持つ", () => {
    expect(OUTBOUND_RETRY_DELAYS_MINUTES).toEqual([1, 5, 30, 120, 360]);
    expect(OUTBOUND_MAX_ATTEMPTS).toBe(5);
  });

  it("0 以下は 1 回目として扱う", () => {
    expect(outboundRetryDelaySeconds(0)).toBe(60);
  });

  it("**受信側の刻みと別の表**（片方を直しても他方が変わらない）", () => {
    expect(OUTBOUND_RETRY_DELAYS_MINUTES).not.toEqual(RETRY_DELAYS_MINUTES);
  });
});

describe("outboundRetryDelaySeconds — 負例（打ち止め）", () => {
  it("6 回目は再送しない", () => {
    expect(outboundRetryDelaySeconds(6)).toBeNull();
  });

  it("100 回目も再送しない", () => {
    expect(outboundRetryDelaySeconds(100)).toBeNull();
  });

  it("遅延は必ず増える方向（縮まない）", () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => outboundRetryDelaySeconds(attempt) ?? 0);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });
});

describe("shouldDisableOutbound（§6.4 の 5 回）", () => {
  it("5 回で無効化する", () => {
    expect(shouldDisableOutbound(OUTBOUND_DISABLE_THRESHOLD)).toBe(true);
  });

  it("6 回でも無効化する（取りこぼさない）", () => {
    expect(shouldDisableOutbound(6)).toBe(true);
  });

  it("4 回では無効化しない", () => {
    expect(shouldDisableOutbound(4)).toBe(false);
  });

  it("0 回では無効化しない", () => {
    expect(shouldDisableOutbound(0)).toBe(false);
  });

  it("閾値は 5", () => {
    expect(OUTBOUND_DISABLE_THRESHOLD).toBe(5);
  });
});

describe("subscribesTo（§6.4 の 6 イベント）", () => {
  it("6 件そのまま並んでいる", () => {
    expect(OUTBOUND_EVENT_VALUES).toHaveLength(6);
  });

  it("登録したイベントは送る", () => {
    expect(subscribesTo(["task.completed"], "task.completed")).toBe(true);
  });

  it("登録していないイベントは送らない", () => {
    expect(subscribesTo(["task.completed"], "invoice.issued")).toBe(false);
  });

  it("空なら 1 件も送らない", () => {
    for (const event of OUTBOUND_EVENT_VALUES) {
      expect(subscribesTo([], event), event).toBe(false);
    }
  });

  it("**ワイルドカードを実装しない**（`task.*` は何にも当たらない）", () => {
    expect(subscribesTo(["task.*"], "task.completed")).toBe(false);
  });
});

describe("isDeliverySuccess", () => {
  it.each([200, 201, 202, 204, 299])("%i は成功", (status) => {
    expect(isDeliverySuccess(status)).toBe(true);
  });

  it("**3xx を成功に数えない**（署名付きの本文が別ホストへ行く）", () => {
    expect(isDeliverySuccess(301)).toBe(false);
    expect(isDeliverySuccess(302)).toBe(false);
  });

  it.each([400, 401, 403, 404, 422])("%i は失敗（相手の設定違いも数える）", (status) => {
    expect(isDeliverySuccess(status)).toBe(false);
  });

  it.each([500, 502, 503])("%i は失敗", (status) => {
    expect(isDeliverySuccess(status)).toBe(false);
  });

  it("199 は成功ではない", () => {
    expect(isDeliverySuccess(199)).toBe(false);
  });
});
