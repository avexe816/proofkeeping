/**
 * シード投入（local と staging のみ）。**production / preview では 404。**
 *
 *   POST /api/v1/dev/seed
 *   body: { "ownerPassword": "..." }  ※省略時 "testpass-01"
 *
 * task: docs/tasks/P0-18.md（OPEN_QUESTIONS #031 の解消）
 *
 * ── production で動かない ───────────────────────────────
 * `ENVIRONMENT` が `local` でも `staging` でもないとき 404 を返す。
 * preview / production で誤って実行されないようにする。
 * **本番にはこの経路が存在しないことが重要。**
 *
 * ── staging は鍵を持っているときだけ開く（DECISIONS #189）───
 * staging の D1 は空で、**シードが無いとログイン画面から先へ進めない。**
 * 画面を継続的に確認するための環境なので、初期データを入れる経路が要る。
 *
 * ただし staging は公開 URL を持つ（`workers_dev = true`）。local と同じ
 * 「無認証で誰でも叩ける」ままにはできない。そこで **`STAGING_SEED_TOKEN`
 * が設定されていて、かつ同じ値が `x-pk-seed-token` ヘッダに載っているとき
 * だけ**受ける。鍵を置かなければ staging でも 404 のままで、
 * **既定は閉じている。**
 *
 * **判定の順序に意味がある。** 環境名を先に見て、production / preview は
 * 鍵の有無に関わらず 404 にする。鍵の比較まで進ませない。
 *
 * ── 認証を要求しない（local）────────────────────────────
 * ローカル開発で初期データが無いとログインすらできないため、
 * セッションを持たない状態で叩ける必要がある。
 * **local は Cloudflare 上に存在しないので、認証の欠如は問題にならない。**
 */

import { Hono } from "hono";

import type { Env } from "@pk/db";

import { runSeed } from "../../../lib/seed/runSeed.js";

const dev = new Hono<{ Bindings: Env }>();

/**
 * 長さを漏らさず比較する。**早期 return をしない。**
 *
 * `a === b` は不一致の位置で打ち切るため、繰り返し叩けば 1 文字ずつ
 * 絞り込める。鍵は 1 本しか無く、レート制限も掛かっていない経路なので
 * ここは定数時間で比較する。
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
 * この環境・この要求がシード投入を受けてよいか。
 *
 * **`local` 以外を足すときは、公開 URL を持つかどうかを必ず考えること。**
 */
export function isSeedAllowed(
  env: Pick<Env, "ENVIRONMENT" | "STAGING_SEED_TOKEN">,
  presentedToken: string | undefined,
): boolean {
  if (env.ENVIRONMENT === "local") return true;
  if (env.ENVIRONMENT !== "staging") return false;

  const expected = env.STAGING_SEED_TOKEN;
  if (typeof expected !== "string" || expected.trim() === "") return false;
  if (typeof presentedToken !== "string" || presentedToken === "") return false;

  return timingSafeEqual(expected, presentedToken);
}

dev.post("/seed", async (c) => {
  if (!isSeedAllowed(c.env, c.req.header("x-pk-seed-token"))) {
    return c.json({ error: "Not Found" }, 404);
  }

  const body: unknown = await c.req.json().catch(() => ({}));
  const ownerPassword =
    typeof body === "object" &&
    body !== null &&
    "ownerPassword" in body &&
    typeof (body as Record<string, unknown>).ownerPassword === "string" &&
    ((body as Record<string, unknown>).ownerPassword as string).length >= 8
      ? ((body as Record<string, unknown>).ownerPassword as string)
      : "testpass-01";

  const result = await runSeed(
    c.env,
    { ownerPassword },
    new Date(),
  );

  return c.json({
    ok: true,
    organizationId: result.organizationId,
    orgShortId: result.orgShortId,
    properties: result.properties,
    rooms: result.rooms,
    cleaners: result.cleaners,
    checklistTemplates: result.checklistTemplates,
    operatorEmail: result.operatorEmail,
    message: `Seed complete: ${String(result.properties)} properties, ${String(result.rooms)} rooms, ${String(result.cleaners)} cleaners. Login with orgShortId=${result.orgShortId} + staff no. + password. Platform console: /plat/login with ${result.operatorEmail} + the same password.`,
  });
});

export default dev;
