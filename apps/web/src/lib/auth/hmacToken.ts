/**
 * HMAC-SHA256 の署名と検証。**署名付き URL 系の共通部品**（P5-17 で切り出し）。
 *
 * 使う側: `lib/storage/signedUrl.ts`（写真・帳票の 15 分 URL）/
 * `lib/billing/reviewLink.ts`（確認依頼のメールリンク）。
 *
 * 鍵は `SESSION_SECRET` を流用する。**別 secret を増やさない**
 * （signedUrl.ts の判断を踏襲。運用で片方だけ回されると原因が読めない）。
 */

const encoder = new TextEncoder();

/** HMAC-SHA256 の hex 文字列。 */
export async function hmacHex(secret: string, message: string): Promise<string> {
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
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
