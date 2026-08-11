/**
 * 認証 API。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §2 / §8
 *
 *   POST /api/v1/auth/login    orgShortId + スタッフ番号 + パスワード
 *   POST /api/v1/auth/logout   セッションの破棄
 *
 * ── 応答 ────────────────────────────────────────────────
 *   200 `{ expiresAt }`      成功。セッションは Set-Cookie で運ぶ
 *   400 `INVALID_REQUEST`    入力の形が違う
 *   401 `AUTH_FAILED`        認証できない（**理由を分けない**）
 *   429 `RATE_LIMITED`       IP のレート制限（security.md §8）
 *
 * ── 現在時刻はここで作る ────────────────────────────────
 * `new Date()` を呼んでよいのはハンドラの入口だけ。以降は引数で渡す
 * （CLAUDE.md §5）。同一リクエスト内で時刻がずれると、セッションの
 * 発行時刻と Cookie の `Max-Age` が食い違う。
 *
 * ── ログアウトは常に 204 ────────────────────────────────
 * セッションが無くても、署名が壊れていても 204。「有効なセッションだった」
 * ことが分かる応答を返さない。
 */

import { loginRequestSchema, type AuthErrorCode } from "@pk/contracts";
import type { Env } from "@pk/db";
import { Hono } from "hono";

import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  readSessionCookie,
} from "../../../lib/auth/cookie.js";
import { login } from "../../../lib/auth/login.js";
import { clientIp, consumeRateLimit } from "../../../lib/auth/rateLimit.js";
import { deleteSession } from "../../../lib/auth/session.js";

const auth = new Hono<{ Bindings: Env }>();

/** エラー応答。本体は機械可読なコードだけ。文言は UI が i18n キーで持つ。 */
function errorBody(code: AuthErrorCode): { error: AuthErrorCode } {
  return { error: code };
}

auth.post("/login", async (c) => {
  const now = new Date();

  const rate = await consumeRateLimit(c.env, "login", clientIp(c.req.raw), now);
  if (!rate.allowed) {
    return c.json(errorBody("RATE_LIMITED"), 429, {
      "Retry-After": String(rate.retryAfterSeconds),
    });
  }

  // 本体が JSON でない場合も 400。ここで例外を外へ出さない。
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = loginRequestSchema.safeParse(body);
  if (!parsed.success) return c.json(errorBody("INVALID_REQUEST"), 400);

  const result = await login(c.env, { credentials: parsed.data, now });
  if (!result.ok) return c.json(errorBody("AUTH_FAILED"), 401);

  c.header(
    "Set-Cookie",
    buildSessionCookie(result.session.cookieValue, result.session.maxAgeSeconds),
  );
  return c.json({ expiresAt: new Date(result.session.record.expiresAt).toISOString() });
});

auth.post("/logout", async (c) => {
  const cookieValue = readSessionCookie(c.req.header("Cookie") ?? null);
  if (cookieValue !== null) await deleteSession(c.env, cookieValue);

  // 消えたことを確実にするため、無効なセッションでも Cookie は落とす。
  c.header("Set-Cookie", buildExpiredSessionCookie());
  return c.body(null, 204);
});

export default auth;
