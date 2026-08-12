/**
 * セッション middleware。Cookie を `SessionRecord` に変える。
 *
 * task:  docs/tasks/P0-10.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #020
 *
 * ここが持つのは**識別情報まで。** ロールと担当施設は `tenant.ts` が
 * 毎リクエスト DB から組み立てる（セッションに焼き込まない）。
 *
 * ── `lib/auth/session.ts` との違い ──────────────────────
 *   lib/auth/session.ts  KV への発行・読み出し・破棄（P0-08）
 *   このファイル          HTTP の Cookie とその結果の写像（P0-10）
 * 同名だが責務が違う。KV の読み書きとレコードの検証はあちらが持っている。
 *
 * ── 失敗の理由を分けない ────────────────────────────────
 * Cookie が無い・署名が壊れている・KV に無い・期限切れは**すべて 401
 * `UNAUTHENTICATED` 1 種類。** どれで落ちたかが分かると、有効な
 * セッション ID かどうかを外から確かめられる（security.md §2 と同じ方針）。
 */

import type { ApiErrorCode } from "@pk/contracts";
import type { Context, MiddlewareHandler } from "hono";

import { readSessionCookie } from "../lib/auth/cookie.js";
import { readSession } from "../lib/auth/session.js";

import type { AppEnv } from "./context.js";

/** 401 の応答。**本体にコード以外を載せない。** */
export function unauthenticated(c: Context<AppEnv>): Response {
  const body: { error: ApiErrorCode } = { error: "UNAUTHENTICATED" };
  return c.json(body, 401);
}

/**
 * セッションを解決して文脈に載せる。無ければ 401 で打ち切る。
 *
 * **現在時刻をここで 1 回だけ作る。** 以降は `getNow(c)` を使い、
 * ハンドラやリポジトリで `new Date()` を呼ばない（CLAUDE.md §5）。
 * セッションの期限判定と、その先で書かれる `createdAt` が同じ時刻を見る。
 *
 * **期限切れの Cookie をここで消さない。** 消しに行くと、署名が合わない値を
 * 投げ込むだけで `Set-Cookie` を引き出せる。破棄は `/auth/logout` の責務。
 */
export function sessionMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const now = new Date();
    c.set("now", now);

    const cookieValue = readSessionCookie(c.req.header("Cookie") ?? null);
    if (cookieValue === null) return unauthenticated(c);

    const record = await readSession(c.env, cookieValue, now);
    if (record === null) return unauthenticated(c);

    c.set("session", record);
    await next();
    return;
  };
}
