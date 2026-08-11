/**
 * パスワードのハッシュ化と検証。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #019
 *
 * ── なぜ bcrypt ではないのか ────────────────────────────
 * Workers に bcrypt のネイティブ実装は無く、純 JS の bcryptjs しか選べない。
 * 実測で cost 12 は 1 回 344ms を要し、CLAUDE.md §4 の「CPU 50ms 超の処理を
 * リクエストハンドラで実行しない」を満たせない。**ログインは応答を返すまでに
 * 検証を終える必要があり、Queue へ逃がせない。** WebCrypto の PBKDF2 は
 * ネイティブ実装で、210,000 回が実測 38ms。詳細は DECISIONS #019。
 *
 * ── 保存形式 ────────────────────────────────────────────
 *   pbkdf2$sha256$210000$<salt(base64url)>$<derivedKey(base64url)>
 *
 * **方式と反復回数を値の中に持つ。** 列に持たせると、反復回数を引き上げた瞬間に
 * 既存の行が検証できなくなる。この形なら旧パラメータのハッシュを検証しつつ、
 * `needsRehash()` が true を返した行だけをログイン成功時に作り直せる。
 *
 * ── この形式を解釈してよいのはこのファイルだけ ──────────
 * リポジトリ層・API ハンドラは中身を見ない。文字列として運ぶ。
 */

import type { RandomBytes } from "@pk/db";

/**
 * 現行のパラメータ。**設定項目にしない**（docs/PK-IMPL-CONTRACT.md §11.4）。
 * 引き上げにはリリースを要する状態を維持する。
 */
export const PBKDF2_PARAMS = {
  algorithm: "pbkdf2",
  hash: "sha256",
  /** OWASP の PBKDF2-HMAC-SHA256 推奨（600,000 回）は実測 103ms で CPU 予算を超える。 */
  iterations: 210_000,
  saltBytes: 16,
  /** SHA-256 の出力長に合わせる。これ以上伸ばしても強度は上がらない。 */
  keyBytes: 32,
} as const;

/** WebCrypto の hash 名。保存形式の `sha256` と 1 対 1 で対応させる。 */
const SUBTLE_HASH = "SHA-256";

/** 解析済みのハッシュ。 */
interface ParsedPasswordHash {
  iterations: number;
  salt: Uint8Array;
  derivedKey: Uint8Array;
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 長さと内容を定数時間で比較する。
 *
 * **早期 return を書かないこと。** 一致した先頭バイト数が実行時間に出ると、
 * 1 バイトずつ導出値を当てられる。
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: SUBTLE_HASH, salt, iterations },
    key,
    PBKDF2_PARAMS.keyBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 保存形式の文字列を作る。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function hashPassword(
  password: string,
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<string> {
  const salt = randomBytes(PBKDF2_PARAMS.saltBytes);
  const derivedKey = await deriveKey(password, salt, PBKDF2_PARAMS.iterations);
  return [
    PBKDF2_PARAMS.algorithm,
    PBKDF2_PARAMS.hash,
    String(PBKDF2_PARAMS.iterations),
    toBase64Url(salt),
    toBase64Url(derivedKey),
  ].join("$");
}

/** 壊れた値・別方式は `null`。**例外を投げない**（検証側で「不一致」に倒すため）。 */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algorithm, hash, iterationsText, saltText, keyText] = parts;
  if (algorithm !== PBKDF2_PARAMS.algorithm || hash !== PBKDF2_PARAMS.hash) return null;
  if (iterationsText === undefined || !/^[1-9][0-9]*$/.test(iterationsText)) return null;
  const iterations = Number(iterationsText);
  // 実行時間の上限を持たせる。壊れた値や細工された値で CPU を焼かせない。
  if (!Number.isSafeInteger(iterations) || iterations > PBKDF2_PARAMS.iterations * 4) return null;
  const salt = saltText === undefined ? null : fromBase64Url(saltText);
  const derivedKey = keyText === undefined ? null : fromBase64Url(keyText);
  if (salt === null || derivedKey === null || salt.length === 0 || derivedKey.length === 0) {
    return null;
  }
  return { iterations, salt, derivedKey };
}

/**
 * 平文と保存値を照合する。
 *
 * 解析できない値は `false`。**「ハッシュが壊れているから通す」を作らない。**
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return false;
  const derivedKey = await deriveKey(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(derivedKey, parsed.derivedKey);
}

/**
 * 現行パラメータで作り直すべきか。
 *
 * 反復回数を引き上げたあと、ログイン成功時にだけ呼んで段階移行する。
 * **移行のためにパスワードの再設定を利用者へ求めない。**
 */
export function needsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return true;
  return parsed.iterations !== PBKDF2_PARAMS.iterations;
}

/**
 * 直近の世代と同じパスワードか（security.md §2「直近 3 世代の再利用禁止」）。
 *
 * ハッシュはソルトを含むため、**同じ平文でも文字列は一致しない。**
 * SQL での比較では判定できず、世代ごとに `verifyPassword()` を回す必要がある。
 * 世代数は `PASSWORD_HISTORY_GENERATIONS`（既定 3）なので、
 * 呼び出しは高々 3 回（実測 38ms × 3）。**パスワード設定時のみ呼ぶこと。
 * ログインの経路で呼ぶと CPU が 4 倍になる。**
 */
export async function isPasswordReused(
  password: string,
  recentHashes: readonly string[],
): Promise<boolean> {
  for (const stored of recentHashes) {
    if (await verifyPassword(password, stored)) return true;
  }
  return false;
}
