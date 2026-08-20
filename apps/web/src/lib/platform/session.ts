/**
 * プラットフォーム運営のセッション。実体は Workers KV（`SESSION`）。
 *
 * task:  docs/tasks/PF-01.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #220
 *
 * ── テナントのセッションと交わらせない ──────────────────
 * Cookie 名（`pk_plat_session`）も KV のキー接頭辞（`plat:`）も別にする。
 * **テナント用のセッションで `/plat/*` に入れない・その逆も同じ**（#220 の 3）。
 * 同じ Cookie 名を使い回すと、片方のログアウトがもう片方を巻き込むうえ、
 * 「どちらの身元で来たのか」がハンドラから見えなくなる。
 *
 * ── 認可情報を焼き込まない ──────────────────────────────
 * 保存するのは `operatorId` と期限だけ。表示名も状態も入れない
 * （DECISIONS #020 と同じ理由 — 無効化が最長 12 時間反映されない状態を
 * 作らない）。毎リクエスト `findPlatformOperatorById()` で引き直す。
 *
 * ── 期限を二重に効かせる ────────────────────────────────
 * KV の `expirationTtl` と、レコード内の `expiresAt`。KV の失効は結果整合で
 * 遅れうるため片方に頼らない。**延長しない（絶対期限）。**
 */

import type { Env, RandomBytes } from "@pk/db";

import { signSessionId, verifySignedSessionId } from "../auth/cookie.js";

/** Cookie 名。**`pk_session` と別名**（#220 の 3）。 */
export const PLATFORM_SESSION_COOKIE_NAME = "pk_plat_session";

/**
 * 有効期限。管理系と同じ 12 時間（security.md §2）。
 *
 * **設定項目にしない**（PK-IMPL-CONTRACT §11.4）。
 */
export const PLATFORM_SESSION_TTL_SECONDS = 12 * 60 * 60;

/** KV のキー接頭辞。テナントの `sess:` と衝突しない。 */
const KEY_PREFIX = "plat:";

/** セッション ID の長さ（バイト）。base64url で 43 文字になる。 */
const SESSION_ID_BYTES = 32;

/** KV に置くレコード。**ここに表示名や権限を足さないこと。** */
export interface PlatformSessionRecord {
  /** 形式の版。読み出し時に照合し、違えば無効として扱う。 */
  v: 1;
  operatorId: string;
  /** epoch ミリ秒。 */
  issuedAt: number;
  /** epoch ミリ秒。絶対期限。 */
  expiresAt: number;
}

/** 発行結果。`cookieValue` をそのまま `Set-Cookie` に載せる。 */
export interface CreatedPlatformSession {
  record: PlatformSessionRecord;
  /** 署名付きの Cookie 値。**生の `sessionId` を外へ出さない。** */
  cookieValue: string;
  maxAgeSeconds: number;
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * セッションを発行する。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function createPlatformSession(
  env: Env,
  input: { operatorId: string; now: Date },
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<CreatedPlatformSession> {
  const issuedAt = input.now.getTime();
  const record: PlatformSessionRecord = {
    v: 1,
    operatorId: input.operatorId,
    issuedAt,
    expiresAt: issuedAt + PLATFORM_SESSION_TTL_SECONDS * 1000,
  };

  const sessionId = toBase64Url(randomBytes(SESSION_ID_BYTES));
  await env.SESSION.put(KEY_PREFIX + sessionId, JSON.stringify(record), {
    expirationTtl: PLATFORM_SESSION_TTL_SECONDS,
  });

  return {
    record,
    cookieValue: await signSessionId(sessionId, env.SESSION_SECRET),
    maxAgeSeconds: PLATFORM_SESSION_TTL_SECONDS,
  };
}

/**
 * Cookie の値からセッションを読む。
 *
 * 署名の検証を KV アクセスの**前**に済ませる（偽の ID を KV へ届かせない）。
 * 期限切れ・形式ちがいは `null`。**理由を返さない。**
 */
export async function readPlatformSession(
  env: Env,
  cookieValue: string | null,
  now: Date,
): Promise<PlatformSessionRecord | null> {
  if (cookieValue === null) return null;
  const sessionId = await verifySignedSessionId(cookieValue, env.SESSION_SECRET);
  if (sessionId === null) return null;

  const raw = await env.SESSION.get(KEY_PREFIX + sessionId);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<PlatformSessionRecord>;
  if (record.v !== 1) return null;
  if (typeof record.operatorId !== "string") return null;
  if (typeof record.expiresAt !== "number" || record.expiresAt <= now.getTime()) return null;

  return record as PlatformSessionRecord;
}

/** ログアウト。**KV の実体を消す**（Cookie を消すだけにしない）。 */
export async function destroyPlatformSession(env: Env, cookieValue: string | null): Promise<void> {
  if (cookieValue === null) return;
  const sessionId = await verifySignedSessionId(cookieValue, env.SESSION_SECRET);
  if (sessionId === null) return;
  await env.SESSION.delete(KEY_PREFIX + sessionId);
}

/** `Set-Cookie` の値。 */
export function buildPlatformSessionCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${PLATFORM_SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${String(maxAgeSeconds)}`,
  ].join("; ");
}

/** ログアウト用。値を空にし、即時失効させる。 */
export function buildExpiredPlatformSessionCookie(): string {
  return buildPlatformSessionCookie("", 0);
}

/** `Cookie` ヘッダから `pk_plat_session` を取り出す。無ければ `null`。 */
export function readPlatformSessionCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== PLATFORM_SESSION_COOKIE_NAME) continue;
    const value = part.slice(index + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}
