/**
 * 署名付き URL の受け口。
 *
 *   GET /api/v1/files/{key}?exp=...&sig=...
 *
 * task:  docs/tasks/P0-16.md
 * ルール: .claude/rules/security.md §4
 *
 * ── セッションと署名の両方を要求する ────────────────────
 * この経路は `/api/v1/*` に載せてあるので、**セッションが無ければ
 * 署名を見る前に 401 になる**（`src/index.ts` の `useTenantMiddleware`）。
 * その上で署名を検証する。二重にしてあるのは、
 *   - 署名は「この鍵が発行した」ことしか言わない。URL が漏れれば
 *     期限内は誰でも読める（`lib/storage/signedUrl.ts` の注記）
 *   - セッションだけでは、URL に有効期限を持たせられない
 * の両方を埋めるため。**片方を外さないこと。**
 *
 * 帳票の PDF に角印を載せる経路（P5）は Queue コンシューマの中から
 * R2 を直に読む。**この HTTP 経路を経由しない**ので、認証を外す理由にならない。
 *
 * ── 置いてよいのは公開しても業務が壊れないものだけ ──────
 * P0 で扱うのは角印だけ。**清掃写真をここへ載せない**（security.md §4 は
 * 写真に別のキー体系と保持期間を定めている）。載せる task が
 * 判定と経路を自分で足すこと。
 */

import { DOCUMENTS_PREFIX } from "../../../lib/storage/prefix.js";
import { verifyObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getNow, type AppEnv } from "../../../middleware/index.js";
import { Hono } from "hono";

const files = new Hono<AppEnv>();

files.get("/:key", async (c) => {
  const key = decodeURIComponent(c.req.param("key"));

  // 署名の対象を絞る。**任意のキーを読める口にしない。**
  if (!key.startsWith(DOCUMENTS_PREFIX)) return c.notFound();

  const valid = await verifyObjectUrl(
    c.env.SESSION_SECRET,
    key,
    c.req.query("exp"),
    c.req.query("sig"),
    getNow(c),
  );
  // 署名が違う・期限切れ・存在しない、をすべて 404 にする。
  // 期限切れだけ 403 にすると、キーの存在が読める。
  if (!valid) return c.notFound();

  const object = await c.env.DOCUMENTS.get(key);
  if (object === null) return c.notFound();

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      // 署名の期限より長く持たせない。
      "Cache-Control": "private, max-age=300",
    },
  });
});

export default files;
