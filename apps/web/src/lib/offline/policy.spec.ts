/**
 * 送信キューの規則（PK-SPEC-P1 §8.2 / §8.1）。
 *
 * task: docs/tasks/P1-12.md
 *
 * ── 見ているもの ────────────────────────────────────────
 *   指数バックオフ 1s→2s→4s→8s→16s
 *   5 回失敗で `requiresManualRetry`（赤バッジ）
 *   **409 は成功として扱う**（§8.2 MUST）
 *   直列送信の順序（積んだ順）
 *   24 時間以上の未送信で警告（§8.1）
 */

import { describe, expect, it } from "vitest";

import {
  MAX_ATTEMPTS,
  STALE_AFTER_MS,
  backoffDelayMs,
  hasManualRetry,
  hasStaleItems,
  nextToSend,
  resetManualRetry,
  verdictOf,
  verdictOfNetworkFailure,
  type QueuedRequest,
} from "./policy.js";

function queued(overrides: Partial<QueuedRequest> = {}): QueuedRequest {
  return {
    id: "q1",
    url: "/api/v1/tasks/t1/start",
    method: "POST",
    body: {},
    createdAt: 1_000,
    attempts: 0,
    requiresManualRetry: false,
    ...overrides,
  };
}

describe("backoffDelayMs", () => {
  it("1s → 2s → 4s → 8s → 16s（§8.2）", () => {
    expect([1, 2, 3, 4, 5].map(backoffDelayMs)).toEqual([1000, 2000, 4000, 8000, 16_000]);
  });

  it("初回は待たない", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-1)).toBe(0);
  });

  it("5 回を超えても 16s で頭打ち", () => {
    expect(backoffDelayMs(9)).toBe(16_000);
  });
});

describe("verdictOf", () => {
  it("2xx はキューから消す", () => {
    expect(verdictOf(200, 1)).toEqual({ kind: "DONE" });
    expect(verdictOf(204, 1)).toEqual({ kind: "DONE" });
  });

  it("409（処理済・状態が合わない）も成功として消す（§8.2 MUST）", () => {
    expect(verdictOf(409, 1)).toEqual({ kind: "DONE" });
    expect(verdictOf(409, MAX_ATTEMPTS)).toEqual({ kind: "DONE" });
  });

  it("400 / 404 は何度送っても通らないので諦める", () => {
    expect(verdictOf(400, 1)).toEqual({ kind: "GIVE_UP" });
    expect(verdictOf(404, 1)).toEqual({ kind: "GIVE_UP" });
    expect(verdictOf(413, 1)).toEqual({ kind: "GIVE_UP" });
  });

  it("401 は粘る（入り直せば通る）", () => {
    expect(verdictOf(401, 1)).toEqual({ kind: "RETRY" });
    expect(verdictOf(401, MAX_ATTEMPTS)).toEqual({ kind: "GIVE_UP" });
  });

  it("5xx は 5 回まで粘る", () => {
    expect(verdictOf(500, 1)).toEqual({ kind: "RETRY" });
    expect(verdictOf(503, 4)).toEqual({ kind: "RETRY" });
    expect(verdictOf(500, MAX_ATTEMPTS)).toEqual({ kind: "GIVE_UP" });
  });

  it("通信そのものの失敗も 5 回まで", () => {
    expect(verdictOfNetworkFailure(1)).toEqual({ kind: "RETRY" });
    expect(verdictOfNetworkFailure(MAX_ATTEMPTS)).toEqual({ kind: "GIVE_UP" });
  });
});

describe("nextToSend", () => {
  it("積んだ順に 1 件ずつ（直列送信）", () => {
    const next = nextToSend([
      queued({ id: "b", createdAt: 2_000 }),
      queued({ id: "a", createdAt: 1_000 }),
    ]);
    expect(next?.id).toBe("a");
  });

  it("赤バッジのものは自動では選ばない", () => {
    const next = nextToSend([
      queued({ id: "a", createdAt: 1_000, requiresManualRetry: true }),
      queued({ id: "b", createdAt: 2_000 }),
    ]);
    expect(next?.id).toBe("b");
  });

  it("全部が赤バッジなら送るものが無い", () => {
    expect(nextToSend([queued({ requiresManualRetry: true })])).toBeUndefined();
  });

  it("空のキューは undefined", () => {
    expect(nextToSend([])).toBeUndefined();
  });
});

describe("resetManualRetry", () => {
  it("手で押したら回数を 0 に戻してまた粘れるようにする", () => {
    const item = queued({ attempts: 5, requiresManualRetry: true, lastError: "HTTP_500" });
    const reset = resetManualRetry(item);
    expect(reset.attempts).toBe(0);
    expect(reset.requiresManualRetry).toBe(false);
    expect(reset.lastError).toBeUndefined();
  });
});

describe("hasManualRetry / hasStaleItems", () => {
  it("5 回失敗が 1 件でもあれば赤バッジ", () => {
    expect(hasManualRetry([queued(), queued({ requiresManualRetry: true })])).toBe(true);
    expect(hasManualRetry([queued(), queued()])).toBe(false);
  });

  it("24 時間以上残っていたら警告（§8.1）", () => {
    const createdAt = 1_000_000;
    expect(hasStaleItems([queued({ createdAt })], createdAt + STALE_AFTER_MS)).toBe(true);
    expect(hasStaleItems([queued({ createdAt })], createdAt + STALE_AFTER_MS - 1)).toBe(false);
  });

  it("空のキューは警告しない", () => {
    expect(hasStaleItems([], Date.now())).toBe(false);
    expect(hasManualRetry([])).toBe(false);
  });
});
