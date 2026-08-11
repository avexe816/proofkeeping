/**
 * セッション Cookie（`pk_session`）の組み立てと検証。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §2
 *
 * ── Cookie に入れるもの ─────────────────────────────────
 *   `{sessionId}.{HMAC-SHA256(sessionId, SESSION_SECRET)}`
 *
 * セッションの実体は KV にあり、Cookie が運ぶのは**署名付きの ID だけ**。
 * ユーザー ID・ロール・組織を Cookie に載せない。載せると改竄の検査対象が増え、
 * KV を見なくても権限が決まる経路ができる。
 *
 * ── なぜ署名するのか ────────────────────────────────────
 * ID は 32 バイトの乱数なので推測はできないが、**署名が無いと KV への
 * 総当たりを Worker が肩代わりしてしまう。** 署名の検証は KV アクセスの
 * 前に済ませ、偽の ID は KV へ届かせない。
 */

/** Cookie 名。security.md §2 が定めた固定値。 */
export const SESSION_COOKIE_NAME = "pk_session";

/** 署名の区切り。`sessionId` は base64url なので `.` は現れない。 */
const SEPARATOR = ".";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(sessionId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionId));
  return toBase64Url(new Uint8Array(signature));
}

/** 文字列の定数時間比較。署名の照合に使う。 */
function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cookie に載せる値を作る。 */
export async function signSessionId(sessionId: string, secret: string): Promise<string> {
  return `${sessionId}${SEPARATOR}${await hmac(sessionId, secret)}`;
}

/**
 * Cookie の値から `sessionId` を取り出す。**署名が合わなければ `null`。**
 *
 * 呼び出し側は `null` を「未認証」として扱い、理由を応答に出さないこと。
 */
export async function verifySignedSessionId(
  value: string,
  secret: string,
): Promise<string | null> {
  const index = value.indexOf(SEPARATOR);
  if (index <= 0 || index === value.length - 1) return null;
  const sessionId = value.slice(0, index);
  const signature = value.slice(index + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const expected = await hmac(sessionId, secret);
  return timingSafeEqualText(signature, expected) ? sessionId : null;
}

/**
 * `Set-Cookie` の値。
 *
 * `Secure` はローカル（http://localhost）でも付ける。環境で分岐させると
 * 本番で外れる事故の余地が残るため。**Chrome / Safari は localhost を
 * secure context として扱うので、`wrangler dev` でも Cookie は保存される。**
 */
export function buildSessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${String(maxAgeSeconds)}`,
  ].join("; ");
}

/** ログアウト用。値を空にし、即時失効させる。 */
export function buildExpiredSessionCookie(): string {
  return buildSessionCookie("", 0);
}

/** `Cookie` ヘッダから `pk_session` を取り出す。無ければ `null`。 */
export function readSessionCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}
