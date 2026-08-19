/**
 * 確認依頼のメールリンク（P5-17）。
 */

import { describe, expect, it } from "vitest";

import { REVIEW_LINK_TTL_SECONDS, signReviewLinkPath, verifyReviewLink } from "./reviewLink.js";

const SECRET = "test-secret";
const PERIOD_ID = "o7k2m9__bper_01JBXQ3ZK8N4P2VYR60000";
const NOW = new Date("2026-08-19T00:00:00.000Z");

function queryOf(path: string): { exp: string | null; sig: string | null } {
  const url = new URL(path, "https://example.com");
  return { exp: url.searchParams.get("exp"), sig: url.searchParams.get("sig") };
}

describe("メールリンクの署名（P5-17）", () => {
  it("発行したリンクが検証を通る", async () => {
    const path = await signReviewLinkPath(SECRET, PERIOD_ID, NOW);
    const { exp, sig } = queryOf(path);
    expect(await verifyReviewLink(SECRET, PERIOD_ID, exp, sig, NOW)).toBe(true);
  });

  it("有効期限は 30 日", async () => {
    expect(REVIEW_LINK_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    const path = await signReviewLinkPath(SECRET, PERIOD_ID, NOW);
    const { exp, sig } = queryOf(path);
    const justBefore = new Date(Number(exp) * 1000 - 1000);
    const atExpiry = new Date(Number(exp) * 1000);
    expect(await verifyReviewLink(SECRET, PERIOD_ID, exp, sig, justBefore)).toBe(true);
    expect(await verifyReviewLink(SECRET, PERIOD_ID, exp, sig, atExpiry)).toBe(false);
  });

  it("改竄したリンクは通らない", async () => {
    const path = await signReviewLinkPath(SECRET, PERIOD_ID, NOW);
    const { exp, sig } = queryOf(path);
    // 別の期間に付け替え。
    expect(await verifyReviewLink(SECRET, `${PERIOD_ID}x`, exp, sig, NOW)).toBe(false);
    // 期限の延長。
    expect(
      await verifyReviewLink(SECRET, PERIOD_ID, String(Number(exp) + 3600), sig, NOW),
    ).toBe(false);
    // 署名の書き換え。
    const tampered = (sig ?? "").slice(0, -1) + ((sig ?? "").endsWith("0") ? "1" : "0");
    expect(await verifyReviewLink(SECRET, PERIOD_ID, exp, tampered, NOW)).toBe(false);
  });

  it("鍵が違えば通らない", async () => {
    const path = await signReviewLinkPath(SECRET, PERIOD_ID, NOW);
    const { exp, sig } = queryOf(path);
    expect(await verifyReviewLink("other-secret", PERIOD_ID, exp, sig, NOW)).toBe(false);
  });

  it("欠落・数値でない exp は通らない", async () => {
    const path = await signReviewLinkPath(SECRET, PERIOD_ID, NOW);
    const { exp, sig } = queryOf(path);
    expect(await verifyReviewLink(SECRET, PERIOD_ID, null, sig, NOW)).toBe(false);
    expect(await verifyReviewLink(SECRET, PERIOD_ID, exp, null, NOW)).toBe(false);
    expect(await verifyReviewLink(SECRET, PERIOD_ID, "12e3", sig, NOW)).toBe(false);
  });
});
