/**
 * 初期開通の口を受ける条件を固定する（PF-16）。
 *
 * task: docs/tasks/PF-16.md
 * 決定: docs/DECISIONS.md #245
 *
 * ── ここで何を守っているか ──────────────────────────────
 * `/api/v1/platform/bootstrap` は**無認証で運営担当者を作りうる**経路で、
 * `dev/seed` と違い **production でも開く。** 守っているのは管理鍵 1 本
 * だけなので、開き方そのものをテストで固定する。
 *
 *   - 鍵が未設定なら 404（**既定は閉じている**）
 *   - 値が違えば 404（「鍵が無い」と区別しない）
 *   - 応答に**開通リンクも token も入らない**
 */

import { describe, expect, it, vi } from "vitest";

import type { Env } from "@pk/db";

import { isBootstrapAllowed } from "./platformBootstrap.js";
import platformBootstrap from "./platformBootstrap.js";

const TOKEN = "bootstrap-token-0123456789abcdef";

/** 発行そのものは `lib/platform/bootstrap.spec.ts` が見る。ここは口だけ。 */
vi.mock("../../../lib/platform/bootstrap.js", () => ({
  issuePlatformBootstrap: () =>
    Promise.resolve({ ok: true, expiresAt: new Date("2026-08-21T09:30:00.000Z") }),
}));

function envWith(token: string): Env {
  return { PLATFORM_BOOTSTRAP_TOKEN: token } as unknown as Env;
}

async function post(
  env: Env,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return platformBootstrap.request(
    "/bootstrap",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("isBootstrapAllowed", () => {
  it("鍵が設定され、同じ値が提示されたら受ける", () => {
    expect(isBootstrapAllowed({ PLATFORM_BOOTSTRAP_TOKEN: TOKEN }, TOKEN)).toBe(true);
  });

  it("**鍵が未設定なら受けない。** 既定は閉じている", () => {
    expect(isBootstrapAllowed({ PLATFORM_BOOTSTRAP_TOKEN: "" }, TOKEN)).toBe(false);
  });

  it("空白だけの鍵は「未設定」として扱う", () => {
    expect(isBootstrapAllowed({ PLATFORM_BOOTSTRAP_TOKEN: "   " }, "   ")).toBe(false);
  });

  it("鍵が提示されなければ受けない", () => {
    expect(isBootstrapAllowed({ PLATFORM_BOOTSTRAP_TOKEN: TOKEN }, undefined)).toBe(false);
  });

  it("値が違えば受けない", () => {
    expect(isBootstrapAllowed({ PLATFORM_BOOTSTRAP_TOKEN: TOKEN }, `${TOKEN}x`)).toBe(false);
  });

  it("**環境で分岐しない**（production でも鍵があれば開く / 本番の 1 人目）", () => {
    const env = { PLATFORM_BOOTSTRAP_TOKEN: TOKEN, ENVIRONMENT: "production" };
    expect(isBootstrapAllowed(env as unknown as Env, TOKEN)).toBe(true);
  });
});

describe("POST /api/v1/platform/bootstrap", () => {
  it("鍵が無ければ 404（経路の存在を伏せる）", async () => {
    const response = await post(envWith(""), {}, { email: "a@b.co", displayName: "n" });
    expect(response.status).toBe(404);
  });

  it("鍵が合えば受け、**応答に token も開通リンクも入らない**", async () => {
    const response = await post(
      envWith(TOKEN),
      { "x-pk-bootstrap-token": TOKEN },
      { email: "ops@stek.ai", displayName: "運営 太郎" },
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true, expiresAt: "2026-08-21T09:30:00.000Z" });
    expect(text).not.toContain("/plat/bootstrap/");
    // **宛先も返さない**（要求した本人が知っている / security.md §3）。
    expect(text).not.toContain("ops@stek.ai");
  });

  it("形式が合わなければ 400。**入力を echo しない**", async () => {
    const response = await post(
      envWith(TOKEN),
      { "x-pk-bootstrap-token": TOKEN },
      { email: "not-an-email", displayName: "" },
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "INVALID_REQUEST" });
    expect(text).not.toContain("not-an-email");
  });

  it("本文が JSON でなくても落ちない（400）", async () => {
    const response = await platformBootstrap.request(
      "/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-pk-bootstrap-token": TOKEN },
        body: "{",
      },
      envWith(TOKEN),
    );
    expect(response.status).toBe(400);
  });
});
