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
 * P0 で扱うのは角印だけだった。**P1-11 が清掃写真を足した。**
 * 写真は別のバケット（`PHOTOS`）・別のキー体系・別の保持期間を持つ
 * （security.md §4）ので、接頭辞でバケットを選ぶ。
 *
 * ── 写真はテナントも照合する ────────────────────────────
 * 写真のキーには組織 ID が入る（`photos/{orgId}/…`）。**署名が正しくても、
 * 自分の組織のキーでなければ 404 にする。** 署名は「この鍵が発行した」しか
 * 言わないので、別組織の URL が何かの拍子に渡ったときの最後の砦になる。
 * 角印にこの照合が無いのは、キーに組織 ID が入っていて発行元が
 * 組織スコープの画面しか無いため（P0-16 のまま）。
 */

import { DOCUMENTS_PREFIX } from "../../../lib/storage/prefix.js";
import { PHOTOS_PREFIX, isOwnPhotoKey } from "../../../lib/photo/upload.js";
import { verifyObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getNow, getTenant, type AppEnv } from "../../../middleware/index.js";
import { Hono } from "hono";

const files = new Hono<AppEnv>();

files.get("/:key", async (c) => {
  const key = decodeURIComponent(c.req.param("key"));

  // 署名の対象を絞る。**任意のキーを読める口にしない。**
  const isDocument = key.startsWith(DOCUMENTS_PREFIX);
  const isPhoto = key.startsWith(PHOTOS_PREFIX);
  if (!isDocument && !isPhoto) return c.notFound();
  if (isPhoto && !isOwnPhotoKey(key, getTenant(c).organizationId)) return c.notFound();

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

  const object = await (isPhoto ? c.env.PHOTOS : c.env.DOCUMENTS).get(key);
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
