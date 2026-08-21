/**
 * 運営担当者の初期開通の口（PF-16 / **1 人目だけ**）。
 *
 *   POST /api/v1/platform/bootstrap
 *   header: x-pk-bootstrap-token: <管理鍵>
 *   body:   { "email": "...", "displayName": "..." }
 *
 * task: docs/tasks/PF-16.md
 * 決定: docs/DECISIONS.md #240（オーナー判断）・#245（この実装）
 * 手順: docs/runbook/platform-bootstrap.md
 *
 * ── 押した人しか通れない ────────────────────────────────
 * **`PLATFORM_BOOTSTRAP_TOKEN` が設定されていて、同じ値が
 * `x-pk-bootstrap-token` に載っているときだけ**受ける。鍵が無ければ 404 で、
 * **既定は閉じている**（`dev.ts` のシード経路と同じ形 / DECISIONS #189）。
 *
 * 鍵は workflow が実行のたびに作って登録し、**終わったら消す**
 * （`.github/workflows/platform-bootstrap.yml`）。開いているのは
 * 人が押している数分だけになる。
 *
 * ── なぜ「運営担当者が居なければ誰でも通れる」ではいけないか ──
 * 「まだ 1 人も居ない」ことは外から観測できる状態で、staging も
 * production も公開 URL を持つ。鍵が無ければ、**最初に見つけた誰かが
 * 自分のメールで運営担当者になれる。**
 *
 * ── 環境で分岐しない ────────────────────────────────────
 * `dev.ts` と違い production でも開く（**本番の 1 人目を作るための経路**）。
 * 代わりに鍵を必須にする。`ENVIRONMENT` を見ないので、環境を増やしたときに
 * 書き漏らした環境から開く形にならない（`notify.ts` の判断と同じ向き）。
 *
 * ── 応答に秘密を載せない ────────────────────────────────
 * 返すのは `ok` と期限だけ。**開通リンクも token も返さない**（要件 10）。
 * 受け取るのは GitHub Actions の runner で、応答はログに出うる。
 */

import { platformBootstrapRequestSchema } from "@pk/contracts";
import { Hono } from "hono";

import type { Env } from "@pk/db";

import { clientIp } from "../../../lib/auth/rateLimit.js";
import { issuePlatformBootstrap } from "../../../lib/platform/bootstrap.js";

const platformBootstrap = new Hono<{ Bindings: Env }>();

/**
 * 長さを漏らさず比較する。**早期 return をしない**（`dev.ts` と同じ理由）。
 *
 * 鍵は 1 本しか無く、この経路にレート制限は掛かっていない。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * この要求が初期開通を押してよいか。
 *
 * **鍵が置かれていない環境は 404。** 「置かれていない」と「値が違う」を
 * 区別しない（経路の存在そのものを伏せる）。
 */
export function isBootstrapAllowed(
  env: Pick<Env, "PLATFORM_BOOTSTRAP_TOKEN">,
  presentedToken: string | undefined,
): boolean {
  const expected = env.PLATFORM_BOOTSTRAP_TOKEN;
  if (typeof expected !== "string" || expected.trim() === "") return false;
  if (typeof presentedToken !== "string" || presentedToken === "") return false;
  return timingSafeEqual(expected, presentedToken);
}

platformBootstrap.post("/bootstrap", async (c) => {
  if (!isBootstrapAllowed(c.env, c.req.header("x-pk-bootstrap-token"))) {
    return c.json({ error: "Not Found" }, 404);
  }

  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = platformBootstrapRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // **入力の中身を応答に載せない**（メールアドレスが echo で残る）。
    return c.json({ error: "INVALID_REQUEST" }, 400);
  }

  const result = await issuePlatformBootstrap(c.env, {
    email: parsed.data.email,
    displayName: parsed.data.displayName,
    now: new Date(),
    ip: clientIp(c.req.raw),
  });

  if (!result.ok) {
    // 409 = 既に運営担当者が居る（**押し直しても変わらない**）。
    // 503 = メールが送れない（**設定を直せば通る**）。
    const status = result.reason === "OPERATOR_EXISTS" ? 409 : 503;
    return c.json({ error: result.reason }, status);
  }

  return c.json({ ok: true, expiresAt: result.expiresAt.toISOString() });
});

export default platformBootstrap;
