/**
 * IP 単位のレート制限（P0-08）。
 */

import type { Env } from "@pk/db";
import { describe, expect, it } from "vitest";

import { RATE_LIMITS, clientIp, consumeRateLimit } from "./rateLimit.js";
import { createFakeKv, type FakeKv } from "./test-support/fake-kv.js";

const NOW = new Date("2026-08-11T09:00:30.000Z");
const IP = "203.0.113.10";

function setup(): { env: Env; kv: FakeKv } {
  const kv = createFakeKv();
  return { env: { RATELIMIT: kv.namespace } as unknown as Env, kv };
}

describe("上限", () => {
  it("security.md §8 の値である（login 10 / pin-login 20）", () => {
    expect(RATE_LIMITS.login.limit).toBe(10);
    expect(RATE_LIMITS.pinLogin.limit).toBe(20);
  });

  it("10 回目までは通り、11 回目で落ちる", async () => {
    const { env } = setup();
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      const result = await consumeRateLimit(env, "login", IP, NOW);
      expect(result.allowed, `${String(i + 1)} 回目`).toBe(true);
    }
    await expect(consumeRateLimit(env, "login", IP, NOW)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("拒否したリクエストで窓を伸ばさない", async () => {
    // 伸ばすと総当たり中は永久に解除されない。
    const { env, kv } = setup();
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      await consumeRateLimit(env, "login", IP, NOW);
    }
    const before = [...kv.store.values()][0]?.value;
    await consumeRateLimit(env, "login", IP, NOW);
    expect([...kv.store.values()][0]?.value).toBe(before);
  });

  it("IP が違えば互いに影響しない", async () => {
    const { env } = setup();
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      await consumeRateLimit(env, "login", IP, NOW);
    }
    await expect(consumeRateLimit(env, "login", "198.51.100.7", NOW)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("bucket が違えば互いに影響しない", async () => {
    const { env } = setup();
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      await consumeRateLimit(env, "login", IP, NOW);
    }
    await expect(consumeRateLimit(env, "pinLogin", IP, NOW)).resolves.toMatchObject({
      allowed: true,
    });
  });
});

describe("窓", () => {
  it("次の分になれば通る", async () => {
    const { env } = setup();
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      await consumeRateLimit(env, "login", IP, NOW);
    }
    const nextWindow = new Date(NOW.getTime() + 60_000);
    await expect(consumeRateLimit(env, "login", IP, nextWindow)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("同じ分の中では窓が変わらない", async () => {
    const { env, kv } = setup();
    await consumeRateLimit(env, "login", IP, NOW);
    await consumeRateLimit(env, "login", IP, new Date(NOW.getTime() + 29_000));
    expect(kv.store.size).toBe(1);
  });

  it("Retry-After は窓の残り秒（最低 1 秒）", async () => {
    const { env } = setup();
    for (let i = 0; i < RATE_LIMITS.login.limit; i++) {
      await consumeRateLimit(env, "login", IP, NOW);
    }
    // 09:00:30 に拒否 → 窓の終わりは 09:01:00 なので 30 秒。
    await expect(consumeRateLimit(env, "login", IP, NOW)).resolves.toMatchObject({
      retryAfterSeconds: 30,
    });
  });

  it("TTL は窓より長く残す（終端で書いた値が先に消えないように）", async () => {
    const { env, kv } = setup();
    await consumeRateLimit(env, "login", IP, NOW);
    expect([...kv.store.values()][0]?.expirationTtl).toBeGreaterThanOrEqual(60);
  });
});

describe("壊れたカウンタ", () => {
  it("数値でない値は 0 から数え直す（実行を止めない）", async () => {
    const { env, kv } = setup();
    await consumeRateLimit(env, "login", IP, NOW);
    const key = [...kv.store.keys()][0] ?? "";
    kv.seed(key, "壊れた値");
    await expect(consumeRateLimit(env, "login", IP, NOW)).resolves.toMatchObject({
      allowed: true,
    });
    expect(kv.store.get(key)?.value).toBe("1");
  });
});

describe("clientIp", () => {
  it("CF-Connecting-IP を使う", () => {
    const request = new Request("https://example.test/", {
      headers: { "CF-Connecting-IP": IP },
    });
    expect(clientIp(request)).toBe(IP);
  });

  it("X-Forwarded-For を信用しない（詐称できる）", () => {
    const request = new Request("https://example.test/", {
      headers: { "X-Forwarded-For": "198.51.100.1" },
    });
    expect(clientIp(request)).toBe("unknown");
  });

  it("取れなければ固定の識別子に落とす（制限は緩めない）", () => {
    expect(clientIp(new Request("https://example.test/"))).toBe("unknown");
  });
});
