/**
 * 外部連携の資格情報の暗号化保管（PK-SPEC-P6 §2.1 / P6-02）。
 *
 * task:  docs/tasks/P6-02.md
 * ルール: .claude/rules/security.md §7
 * 決定:  docs/DECISIONS.md #138（DB に平文の列を作らない）
 *
 * ── 何を守っているのか ──────────────────────────────────
 * security.md §7 は「API キー・パスワードを DB に平文保存しない。Workers KV に
 * **暗号化して**保管し `credentialRef` で参照する」と定める。KV に置くだけでは
 * 足りない。**KV のダンプが 1 本流出したら全顧客の PMS へログインできる**
 * 状態を作らないために、`CREDENTIAL_ENCRYPTION_KEY` で AES-GCM 暗号化する。
 *
 * D1 側には `credentialRef`（参照キー）しか無い（`schema/integration.ts`）。
 * したがって**片方だけ手に入れても資格情報は復元できない。**
 *
 * ── 参照キーに組織を焼き込む ────────────────────────────
 * 参照キーは `cred:{orgShortId}:{integrationId}:{slot}`。組織を含めるのは
 * 「他組織の行から拾った `credentialRef` を自分の文脈で読む」経路を塞ぐため。
 * `assertCredentialRefBelongsToTenant()` が DB へ行く前に落とす（第 2 層と
 * 同じ考え方 / architecture.md §2）。**403 ではなく `NotFoundError`。**
 *
 * ── AAD に参照キーを入れる ──────────────────────────────
 * 暗号文は参照キーに束縛する（AES-GCM の additional data）。KV の値だけを
 * 別のキーへコピーしても復号できない。**暗号文の載せ替えで他組織の連携に
 * 自分の資格情報を差し込む**経路を塞ぐ。
 *
 * ── 保存形式 ────────────────────────────────────────────
 *   pkenc$v1$<iv(base64url)>$<ciphertext+tag(base64url)>
 *
 * `pbkdf2$...`（auth/pbkdf2.ts）と同じ自己記述文字列。鍵の交代や方式の
 * 変更を段階移行できる形にしておく。**この形式を解釈してよいのはここだけ。**
 *
 * ── TTL を付けない ──────────────────────────────────────
 * `CREDENTIALS` へ `expirationTtl` / `expiration` を指定しない。失効すると
 * 連携が「設定済みなのに認証できない」状態に静かに落ちる。消すのは
 * 連携そのものを消すときだけ（`deleteCredential()`）。
 */

import { NotFoundError, type Env, type TenantContext } from "@pk/db";

/** KV のキー接頭辞。`CREDENTIALS` namespace には資格情報以外を置かない。 */
const KEY_PREFIX = "cred:";

/** 保存形式の先頭。版を上げるときはここを増やす。 */
const ENVELOPE_PREFIX = "pkenc$v1$";

/** AES-GCM の IV 長（バイト）。96bit は GCM の推奨値。 */
const IV_BYTES = 12;

/** 暗号化鍵の長さ（バイト）。AES-256。 */
const KEY_BYTES = 32;

/**
 * 1 つの連携が持てる資格情報の枠。
 *
 * `API` は外部システムへログインするための値（API キー・パスワード・
 * アクセストークン）。`WEBHOOK` は**受信した署名を検証するための鍵**で、
 * 用途が違うので同じ封筒に入れない。片方だけを差し替えられる形にしておく。
 */
export const CREDENTIAL_SLOTS = ["API", "WEBHOOK"] as const;

export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

/**
 * 封筒の中身。
 *
 * **値は文字列だけ。** 構造化した値を入れたくなったら、それは資格情報では
 * なく設定（`integration.config`）である可能性が高い。
 */
export interface CredentialFields {
  [field: string]: string;
}

/** KV に置く平文（暗号化前）。 */
interface CredentialRecord {
  v: 1;
  fields: CredentialFields;
  /** epoch ミリ秒。**鍵の最終更新**であって、外部システム側の有効期限ではない。 */
  updatedAt: number;
}

// ────────────────────────────────────────────────────────────
// 参照キー
// ────────────────────────────────────────────────────────────

/** 参照キーの形。`orgShortId` は 6 桁英数（id.ts と同じ）。 */
const REF_PATTERN = /^cred:([0-9a-z]{6}):([0-9a-z]{6}__intg_[0-9A-HJKMNP-TV-Z]{26}):(API|WEBHOOK)$/;

/**
 * 参照キーを組み立てる。**DB に入るのはこの文字列だけ。**
 *
 * `integrationId` は自己記述 ID（`{orgShortId}__intg_{ulid}`）なので、
 * 参照キーだけを見て組織を判定できる。**KV は 16 シャードの外側にあり、
 * 全組織で 1 つの namespace を共有する**ため、この判定が要る。
 */
export function credentialRefFor(
  ctx: Pick<TenantContext, "orgShortId">,
  integrationId: string,
  slot: CredentialSlot,
): string {
  const ref = `${KEY_PREFIX}${ctx.orgShortId}:${integrationId}:${slot}`;
  // 組み立てた側でも形を確かめる。**壊れた参照キーを DB に書かせない。**
  assertCredentialRefBelongsToTenant(ref, ctx);
  return ref;
}

/**
 * 参照キーがこの組織のものかを確かめる。**KV を引く前に呼ぶこと。**
 *
 * 形式不正と越境で同じ例外を投げる（`assertIdBelongsToTenant()` と同じ理由。
 * 区別するとリソースの存在を示唆する）。
 *
 * @throws {NotFoundError} `RESOURCE_NOT_FOUND`。呼び出し側が 404 に写像する。
 */
export function assertCredentialRefBelongsToTenant(
  ref: string,
  ctx: Pick<TenantContext, "orgShortId">,
): void {
  const matched = REF_PATTERN.exec(ref);
  const refOrg = matched?.[1];
  const idOrg = matched?.[2]?.slice(0, 6);
  if (refOrg === undefined || idOrg === undefined) throw new NotFoundError();
  // 参照キーの組織部と、埋め込まれた ID の組織部の**両方**を見る。
  // 片方だけだと `cred:aaaaaa:bbbbbb__intg_...` が通る。
  if (refOrg !== ctx.orgShortId || idOrg !== ctx.orgShortId) throw new NotFoundError();
}

// ────────────────────────────────────────────────────────────
// 暗号
// ────────────────────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * `CREDENTIAL_ENCRYPTION_KEY` を AES-GCM 鍵にする。
 *
 * **未設定・長さ違いを黙って通さない。** 弱い鍵で暗号化した気になるより、
 * 資格情報の保存そのものを失敗させる。
 */
async function importKey(secret: string): Promise<CryptoKey> {
  if (secret === "") throw new Error("CREDENTIAL_ENCRYPTION_KEY_MISSING");
  const raw = fromBase64Url(secret);
  if (raw.length !== KEY_BYTES) throw new Error("CREDENTIAL_ENCRYPTION_KEY_INVALID");
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** `size` バイトの乱数を返す関数。テストでのみ差し替える。 */
export type RandomBytesFn = (size: number) => Uint8Array;

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/** 暗号化する。AAD は参照キー（暗号文をその場所に束縛する）。 */
async function seal(
  secret: string,
  ref: string,
  record: CredentialRecord,
  randomBytes: RandomBytesFn,
): Promise<string> {
  const key = await importKey(secret);
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, additionalData: new TextEncoder().encode(ref) },
    key,
    new TextEncoder().encode(JSON.stringify(record)),
  );
  return `${ENVELOPE_PREFIX}${toBase64Url(iv)}$${toBase64Url(new Uint8Array(sealed))}`;
}

/** 復号する。形式不正・改竄・鍵違いはすべて `null`（区別しない）。 */
async function open(secret: string, ref: string, envelope: string): Promise<CredentialRecord | null> {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) return null;
  const [ivPart, cipherPart, ...rest] = envelope.slice(ENVELOPE_PREFIX.length).split("$");
  if (ivPart === undefined || cipherPart === undefined || rest.length > 0) return null;

  try {
    const key = await importKey(secret);
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(ivPart).buffer as ArrayBuffer,
        additionalData: new TextEncoder().encode(ref),
      },
      key,
      fromBase64Url(cipherPart).buffer as ArrayBuffer,
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(opened));
    if (typeof parsed !== "object" || parsed === null) return null;
    // **`Partial<CredentialRecord>` に落とさない。** JSON から来た値は
    // 型が付いていないので、鍵の有無をその場で見る。
    const record = parsed as Record<string, unknown>;
    const fields = record["fields"];
    if (record["v"] !== 1 || typeof fields !== "object" || fields === null) return null;
    const updatedAt = record["updatedAt"];
    return {
      v: 1,
      fields: fields as CredentialFields,
      updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
    };
  } catch {
    // **鍵違いと改竄と形式不正を区別しない。** 呼び出し側は「読めなかった」
    // だけを知ればよい。
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// 保管
// ────────────────────────────────────────────────────────────

/** 資格情報を保存する。**同じ参照キーへの上書きが更新。** */
export async function putCredential(
  env: Env,
  ctx: Pick<TenantContext, "orgShortId" | "now">,
  ref: string,
  fields: CredentialFields,
  randomBytes: RandomBytesFn = defaultRandomBytes,
): Promise<void> {
  assertCredentialRefBelongsToTenant(ref, ctx);
  const envelope = await seal(
    env.CREDENTIAL_ENCRYPTION_KEY,
    ref,
    { v: 1, fields, updatedAt: ctx.now.getTime() },
    randomBytes,
  );
  // **TTL を指定しない**（上の注記）。
  await env.CREDENTIALS.put(ref, envelope);
}

/**
 * 資格情報を読む。無い・読めないときは `null`。
 *
 * **`null` を「認証不要」に読み替えないこと。** 呼び出し側は接続を
 * 失敗させる（署名検証なら 401）。
 */
export async function getCredential(
  env: Env,
  ctx: Pick<TenantContext, "orgShortId">,
  ref: string,
): Promise<CredentialFields | null> {
  assertCredentialRefBelongsToTenant(ref, ctx);
  const envelope = await env.CREDENTIALS.get(ref);
  if (envelope === null) return null;
  const record = await open(env.CREDENTIAL_ENCRYPTION_KEY, ref, envelope);
  return record?.fields ?? null;
}

/** 資格情報を消す。**連携そのものを消すときだけ呼ぶ。** */
export async function deleteCredential(
  env: Env,
  ctx: Pick<TenantContext, "orgShortId">,
  ref: string,
): Promise<void> {
  assertCredentialRefBelongsToTenant(ref, ctx);
  await env.CREDENTIALS.delete(ref);
}
