/**
 * R2 オブジェクトの署名付き URL。
 *
 * task:  docs/tasks/P0-16.md
 * ルール: .claude/rules/security.md §4（閲覧は 15 分有効の署名付き URL）
 *
 * ── R2 の binding に署名付き URL の API が無い ──────────
 * S3 互換の presign は資格情報（アクセスキー）を要する。Worker から
 * 使えるのは binding だけなので、**署名は自前で作り、配信も Worker が行う。**
 *
 *   /api/v1/files/{key}?exp=...&sig=...
 *
 * `sig` は `HMAC-SHA256(SESSION_SECRET, "{key}\n{exp}")`。鍵はセッション
 * Cookie の署名と同じ secret を使う。**別 secret を増やさない**
 * （運用で片方だけ回されると原因が読めない失敗になる）。
 *
 * ── URL は認可の代わりではない ──────────────────────────
 * 署名は「この鍵が発行した」ことしか言わない。**誰に見せてよいかは
 * 発行時に判定する。** URL が漏れれば期限内は誰でも読めるので、
 * 有効期間を短くしてある（15 分）。
 */

import { DOCUMENTS_PREFIX } from "./prefix.js";

/** 署名の有効期間（秒）。security.md §4。 */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 長さで漏れないよう、定数時間で比べる。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 署名付きの相対 URL を作る。**呼ぶ前に閲覧してよいか判定すること。** */
export async function signObjectUrl(
  secret: string,
  key: string,
  now: Date,
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + SIGNED_URL_TTL_SECONDS;
  const sig = await hmac(secret, `${key}\n${String(exp)}`);
  return `/api/v1/files/${encodeURIComponent(key)}?exp=${String(exp)}&sig=${sig}`;
}

/** 署名と期限を検証する。**期限切れは偽。** */
export async function verifyObjectUrl(
  secret: string,
  key: string,
  exp: string | undefined,
  sig: string | undefined,
  now: Date,
): Promise<boolean> {
  if (exp === undefined || sig === undefined) return false;
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 <= now.getTime()) return false;
  return timingSafeEqual(await hmac(secret, `${key}\n${exp}`), sig);
}

/** 角印の R2 キー。**組織ごとに 1 つ。** */
export function sealImageKey(organizationId: string): string {
  return `${DOCUMENTS_PREFIX}${organizationId}/seal.img`;
}
