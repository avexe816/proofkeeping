/**
 * R014 — 稼働記録の事後変更（PK-SPEC-P4 §3.10）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── 見ているもの ────────────────────────────────────────
 *   - 清掃完了より**後**の変更だけ
 *   - **`null`（監査ログを確かめていない）は差異にしない**（§1.2）
 */

import { describe, expect, it } from "vitest";

import { R014, R014_BASE_CONFIDENCE } from "./R014.js";
import { occupancyFact, ruleContext } from "./testContext.js";

const COMPLETED_AT = Date.parse("2026-09-09T13:00:00+09:00");
const REVOKED_AT = Date.parse("2026-09-10T02:14:00+09:00");

function revoked(overrides: Parameters<typeof ruleContext>[0] = {}) {
  return ruleContext({
    occupancy: occupancyFact({ isOccupied: false }),
    occupancyRevokedAfterCleaning: { at: REVOKED_AT, cleaningCompletedAt: COMPLETED_AT },
    ...overrides,
  });
}

describe("R014 — 正例（差異になる）", () => {
  it("清掃完了後に取り消されていれば差異", () => {
    const finding = R014.evaluate(revoked());
    expect(finding?.ruleCode).toBe("R014");
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("確信度は固定", () => {
    expect(R014.evaluate(revoked())?.confidence).toBe(R014_BASE_CONFIDENCE);
  });

  it("取消と完了の時刻を根拠に残す", () => {
    const finding = R014.evaluate(revoked());
    expect(finding?.evidence["revokedAt"]).toBe(REVOKED_AT);
    expect(finding?.evidence["cleaningCompletedAt"]).toBe(COMPLETED_AT);
  });

  it("1 ミリ秒でも後なら差異", () => {
    const finding = R014.evaluate(
      revoked({
        occupancyRevokedAfterCleaning: {
          at: COMPLETED_AT + 1,
          cleaningCompletedAt: COMPLETED_AT,
        },
      }),
    );
    expect(finding).not.toBeNull();
  });

  it("根拠は 1 つ（単一シグナル。上限が別に掛かる）", () => {
    expect(R014.evaluate(revoked())?.matchedSignals).toEqual([
      "OCCUPANCY_REVOKED_AFTER_CLEANING",
    ]);
  });

  it("稼働記録が無くても差異になる（取消の事実は監査ログにある）", () => {
    expect(R014.evaluate(revoked({ occupancy: null }))).not.toBeNull();
  });
});

describe("R014 — 負例（差異にしない）", () => {
  it("**確かめていない（null）なら差異にしない**（§1.2）", () => {
    expect(R014.evaluate(revoked({ occupancyRevokedAfterCleaning: null }))).toBeNull();
  });

  it("清掃完了より前の変更は差異にしない", () => {
    expect(
      R014.evaluate(
        revoked({
          occupancyRevokedAfterCleaning: {
            at: COMPLETED_AT - 1000,
            cleaningCompletedAt: COMPLETED_AT,
          },
        }),
      ),
    ).toBeNull();
  });

  it("同時刻は差異にしない（「後」ではない）", () => {
    expect(
      R014.evaluate(
        revoked({
          occupancyRevokedAfterCleaning: {
            at: COMPLETED_AT,
            cleaningCompletedAt: COMPLETED_AT,
          },
        }),
      ),
    ).toBeNull();
  });

  it("取込の時刻がずっと前なら差異にしない", () => {
    expect(
      R014.evaluate(
        revoked({
          occupancyRevokedAfterCleaning: {
            at: Date.parse("2026-09-01T00:00:00+09:00"),
            cleaningCompletedAt: COMPLETED_AT,
          },
        }),
      ),
    ).toBeNull();
  });

  it("既定の文脈（取消なし）では差異にしない", () => {
    expect(R014.evaluate(ruleContext())).toBeNull();
  });
});
