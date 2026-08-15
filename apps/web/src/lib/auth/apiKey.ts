/**
 * 公開 API のキー（PK-SPEC-P6 §6.1 / §6.2 / P6-12）。
 *
 * task:  docs/tasks/P6-12.md
 * ルール: .claude/rules/security.md §7 / .claude/rules/architecture.md §1・§3
 *
 * ── 平文のキーはどこにも残らない（§6.1 MUST）─────────────
 * `issueApiKey()` が返す `token` は**その場で呼び出し元へ返す 1 回きり。**
 * 保存するのは `keyPrefix`（表示用の先頭）と `keyHash`（全体の SHA-256）
 * だけで、**再表示できる実装にしない。**
 *
 * ── トークンに組織短縮 ID を埋める理由（OPEN_QUESTIONS #086）─
 * ```
 * pk_live_{orgShortId}_{secret}
 * 例: pk_live_o7k2m9_7QK3XZ2M9P4VYR6ABCDEFG
 * ```
 *
 * `Authorization: Bearer` だけを受け取る経路には**セッションも組織も無い。**
 * `api_key` を引くにはシャードを決める必要があり、シャードは
 * `organizationId` から決まる（architecture.md §1）。**全シャード走査は
 * 禁止**（同 §3）なので、トークン自体から組織を導けなければ引けない。
 *
 * 案は 2 つあった（OPEN_QUESTIONS #086）。
 *   (a) トークンに組織短縮 ID を埋める ← **これを採った**
 *   (b) `apikey:{sha256}` → `organizationId` を KV に持つ
 *
 * (a) を選んだのは、ID の自己記述（architecture.md §2 第 2 層）と同じ
 * 考え方で、**KV を 1 本増やさずに済み、失効が KV の結果整合に乗らない**
 * ため。`keyPrefix` を `pk_live_{orgShortId}` にすれば §6.1 の見本
 * （`pk_live_abcd`）とも矛盾しない（docs/DECISIONS.md #150）。
 *
 * **組織短縮 ID は秘密ではない。** ログイン画面で利用者が打ち込む値で
 * （security.md §2）、これが露出しても認証は破れない。守っているのは
 * `secret` の 128 ビットと、保存側のハッシュ。
 *
 * ── 秘密の強度 ──────────────────────────────────────────
 * `secret` は 16 バイト（128 ビット）の乱数を Crockford Base32 で 26 文字に
 * したもの。**PBKDF2 に掛けない。** パスワードや PIN と違って推測可能な
 * 空間が無く、総当たりが成立しないため（security.md §2 の PIN の議論と
 * 逆向きの結論）。加えて公開 API は 1 リクエストごとに検証するので、
 * 反復回数はそのまま応答時間に乗る。**効かない強度のために効く遅さを
 * 買わない**（DECISIONS #021 と同じ判断）。
 */

import { sha256HexOfText } from "../evidence/hash.js";

/** トークンの接頭辞（§6.1 の見本）。 */
export const API_KEY_TOKEN_PREFIX = "pk_live_";

/** 秘密の長さ（バイト）。**128 ビット。** */
export const API_KEY_SECRET_BYTES = 16;

/**
 * Crockford Base32 の字母。**`I` / `L` / `O` / `U` を含まない。**
 * ULID と同じ字母で、読み上げ・書き写しの取り違えが起きにくい。
 */
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * トークンの形。
 *
 * `pk_live_{orgShortId 6 桁}_{secret}`。`secret` は Base32 の
 * 大文字英数字で 20 文字以上（16 バイト → 26 文字）。
 */
const TOKEN_PATTERN = /^pk_live_([0-9a-z]{6})_([0-9A-HJKMNP-TV-Z]{20,64})$/;

/** 発行したキー。**`token` を保存しないこと。** */
export interface IssuedApiKey {
  /** 呼び出し元へ 1 回だけ返す平文。**DB にもログにも残さない。** */
  token: string;
  /** 表示用の先頭（`pk_live_o7k2m9`）。**これだけでは認証できない。** */
  keyPrefix: string;
  /** トークン全体の SHA-256（16 進）。 */
  keyHash: string;
}

/** 乱数。**テストから差し替えられるように分けてある。** */
function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/** バイト列を Crockford Base32 へ。 */
function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

/**
 * 新しいキーを発行する（§6.1）。
 *
 * **戻り値の `token` を保存しない。** 呼び出し元は 1 回だけ応答に載せ、
 * 保存するのは `keyPrefix` と `keyHash` だけ。
 */
export async function issueApiKey(orgShortId: string): Promise<IssuedApiKey> {
  const secret = toBase32(randomBytes(API_KEY_SECRET_BYTES));
  const token = `${API_KEY_TOKEN_PREFIX}${orgShortId}_${secret}`;
  return {
    token,
    // §6.1 の見本は `pk_live_abcd`。**秘密の一部を混ぜない**
    // （先頭数文字でも、漏れれば総当たりの空間が縮む）。
    keyPrefix: `${API_KEY_TOKEN_PREFIX}${orgShortId}`,
    keyHash: await hashApiKeyToken(token),
  };
}

/** トークン全体の SHA-256（16 進）。**保存と照合の両方でこれを使う。** */
export async function hashApiKeyToken(token: string): Promise<string> {
  return sha256HexOfText(token);
}

/**
 * `Authorization` ヘッダからトークンを取り出す。
 *
 * **`Bearer ` 以外の方式を通さない。** `Basic` を許すと、キーが
 * ブラウザの認証ダイアログや URL に乗る経路ができる。
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const matched = /^Bearer (.+)$/.exec(header.trim());
  return matched?.[1] ?? null;
}

/**
 * トークンから組織短縮 ID を取り出す（上の注記）。
 *
 * **形が違えば `null`。** 呼び出し側は理由を区別せず 401 を返す
 * （`integrationWebhooks.ts` と同じ / INV-31）。
 */
export function orgShortIdOfToken(token: string): string | null {
  return TOKEN_PATTERN.exec(token)?.[1] ?? null;
}

/** 公開 API のスコープ（§6.2）。**`packages/db` の `API_SCOPES` の写し。** */
export const API_SCOPE_VALUES = [
  "occupancy:write",
  "signals:write",
  "tasks:read",
  "findings:read",
  "reports:read",
  "invoices:read",
  "webhooks:manage",
] as const;

export type ApiScopeValue = (typeof API_SCOPE_VALUES)[number];

/**
 * そのキーがスコープを持つか（§6.2）。
 *
 * **前方一致・ワイルドカードを実装しない。** `occupancy:*` のような
 * 表記を許すと、スコープを 1 つ足すたびに既存のキーの権限が黙って広がる。
 * 完全一致だけ。
 */
export function hasScope(granted: readonly string[], required: ApiScopeValue): boolean {
  return granted.includes(required);
}

/** 使えるキーかの判定に要る値。 */
export interface ApiKeyUsability {
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/**
 * いま使えるキーか。
 *
 * **失効が有効期限より先に効く。** 失効させたキーは、期限が未来でも通さない。
 * `expiresAt` はちょうどその時刻を**含まない**（期限切れ）。
 */
export function isApiKeyUsable(key: ApiKeyUsability, now: Date): boolean {
  if (key.revokedAt !== null) return false;
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * 施設の制限（§6.1 の `propertyIds`）を `allowedPropertyIds` へ写す。
 *
 * **`null` と `[]` を取り違えないこと**（DECISIONS #017）。
 *   `null` = 組織全体（`TenantContext` の `ORG` スコープ相当）
 *   `[]`   = 1 件も見えない
 */
export function allowedPropertyIdsOf(propertyIds: readonly string[] | null): string[] {
  return propertyIds === null ? [] : [...propertyIds];
}
