/**
 * PBKDF2-SHA256 の機構。パスワードと PIN が共有する。
 *
 * task:  docs/tasks/P0-09.md（P0-08 の password.ts から抽出）
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #019（方式）/ #021（PIN も同じ方式にする）
 *
 * ── なぜ抽出したのか ────────────────────────────────────
 * P0-08 ではパスワードだけがこの機構を使っていたので password.ts に閉じていた。
 * P0-09 で PIN が同じ方式を使うことになり（DECISIONS #021）、**反復回数だけが
 * 違う同じコードを 2 つ持つ**状態になった。ソルト長・保存形式・定数時間比較は
 * 片方だけ直すと気付けない類の実装なので、1 か所に寄せる。
 *
 * ── ここはパラメータを決めない ──────────────────────────
 * 反復回数を選ぶのは呼び出し側（password.ts は 210,000、pin.ts は 50,000）。
 * このファイルは「渡されたパラメータで導出する」だけを持つ。
 *
 * ── 保存形式 ────────────────────────────────────────────
 *   pbkdf2$sha256$<iterations>$<salt(base64url)>$<derivedKey(base64url)>
 *
 * **方式と反復回数を値の中に持つ。** 列に持たせると、反復回数を引き上げた瞬間に
 * 既存の行が検証できなくなる。この形なら旧パラメータのハッシュを検証しつつ、
 * `needsRehash()` が true を返した行だけをログイン成功時に作り直せる。
 *
 * ── この形式を解釈してよいのはここだけ ──────────────────
 * リポジトリ層・API ハンドラは中身を見ない。文字列として運ぶ。
 */

import type { RandomBytes } from "@pk/db";

/** 方式ごとのパラメータ。**設定項目にしない**（docs/PK-IMPL-CONTRACT.md §11.4）。 */
export interface Pbkdf2Params {
  algorithm: "pbkdf2";
  hash: "sha256";
  iterations: number;
  saltBytes: number;
  /** SHA-256 の出力長に合わせる。これ以上伸ばしても強度は上がらない。 */
  keyBytes: number;
}

/**
 * 解析を許す反復回数の上限。**壊れた値や細工された値で CPU を焼かせないため。**
 *
 * パスワードの現行値（210,000）の 4 倍を共通の上限に置く。
 * **方式ごとに `iterations × 4` としない。** PIN 側だけ 200,000 にすると、
 * `pin_hash` に強いパラメータのハッシュが入った瞬間に「解析できない → 不一致」へ
 * 倒れ、正しい PIN で締め出される。上限は CPU の安全弁であって方式の識別子ではない。
 */
export const MAX_PARSEABLE_ITERATIONS = 840_000;

/** WebCrypto の hash 名。保存形式の `sha256` と 1 対 1 で対応させる。 */
const SUBTLE_HASH = "SHA-256";

/** 解析済みのハッシュ。 */
export interface ParsedPbkdf2Hash {
  iterations: number;
  salt: Uint8Array;
  derivedKey: Uint8Array;
}

export function defaultRandomBytes(size: number): Uint8Array {
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
  secret: string,
  salt: Uint8Array,
  iterations: number,
  keyBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: SUBTLE_HASH, salt, iterations },
    key,
    keyBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 保存形式の文字列を作る。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function hashSecret(
  secret: string,
  params: Pbkdf2Params,
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<string> {
  const salt = randomBytes(params.saltBytes);
  const derivedKey = await deriveKey(secret, salt, params.iterations, params.keyBytes);
  return [
    params.algorithm,
    params.hash,
    String(params.iterations),
    toBase64Url(salt),
    toBase64Url(derivedKey),
  ].join("$");
}

/** 壊れた値・別方式は `null`。**例外を投げない**（検証側で「不一致」に倒すため）。 */
export function parseStoredHash(stored: string): ParsedPbkdf2Hash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [algorithm, hash, iterationsText, saltText, keyText] = parts;
  if (algorithm !== "pbkdf2" || hash !== "sha256") return null;
  if (iterationsText === undefined || !/^[1-9][0-9]*$/.test(iterationsText)) return null;
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations > MAX_PARSEABLE_ITERATIONS) return null;
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
 *
 * **検証は保存値の反復回数で行い、現行パラメータと照合しない。**
 * 照合すると反復回数を引き上げた瞬間に既存の利用者が全員締め出される。
 * 段階移行は `needsRehash()` が担う。
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return false;
  const derivedKey = await deriveKey(
    secret,
    parsed.salt,
    parsed.iterations,
    parsed.derivedKey.length,
  );
  return timingSafeEqual(derivedKey, parsed.derivedKey);
}

/**
 * 現行パラメータで作り直すべきか。
 *
 * 反復回数を引き上げたあと、ログイン成功時にだけ呼んで段階移行する。
 * **移行のために認証情報の再設定を利用者へ求めない。**
 */
export function needsRehash(stored: string, params: Pbkdf2Params): boolean {
  const parsed = parseStoredHash(stored);
  if (parsed === null) return true;
  return parsed.iterations !== params.iterations;
}
