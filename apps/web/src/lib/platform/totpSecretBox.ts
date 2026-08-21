/**
 * 運営担当者の TOTP secret の暗号化保管（PF-17 / DECISIONS #244）。
 *
 * task:  docs/tasks/PF-17.md
 * ルール: .claude/rules/security.md §7（平文で保存しない）
 *
 * ── 何を守っているのか ──────────────────────────────────
 * `platform_operator.two_factor_secret` に base32 の平文を置くと、
 * **D1 のダンプ 1 本で全運営担当者の第 2 要素が複製できる**（TOTP は
 * 共有秘密方式で、秘密を知れば正しいコードを作れる）。パスワードハッシュと
 * 同じ流出を想定し、`TWO_FACTOR_ENCRYPTION_KEY`（専用の Worker Secret）で
 * AES-256-GCM 暗号化して保存する。**D1 と secret の片方だけでは復元できない。**
 *
 * ── SESSION_SECRET を流用しない ─────────────────────────
 * 鍵は用途ごとに分ける。セッション署名鍵を回すたびに 2FA が全滅する形や、
 * 片方の流出がもう片方を巻き込む形を作らない。
 *
 * ── AAD に担当者 ID を入れる ────────────────────────────
 * 暗号文を `plat2fa:{operatorId}` に束縛する（`lib/integration/credentials.ts`
 * と同じ考え方）。**他の行から暗号文をコピーしても復号できない。**
 *
 * ── 保存形式 ────────────────────────────────────────────
 *   pk2fa$v1$<iv(base64url)>$<ciphertext+tag(base64url)>
 *
 * `pbkdf2$...` / `pkenc$...` と同じ自己記述文字列。鍵や方式の交代を
 * 段階移行できる形にしておく。**この形式を解釈してよいのはここだけ。**
 *
 * ── credentials.ts と共有しない ─────────────────────────
 * 機構はほぼ同じだが、あちらは `TenantContext` を取るテナント面の実装。
 * 運営面のソースにテナントの文脈を持ち込まない（DECISIONS #220 /
 * `platform.spec.ts` の走査が固定している）ため、ここに閉じて持つ。
 *
 * ── 出さない ────────────────────────────────────────────
 * 鍵・平文 secret・復号後 secret をログ・監査ログ・例外メッセージに
 * 載せない。例外は**名前だけ**（`requiredSecrets.ts` と同じ方針）。
 */

import type { Env, RandomBytes } from "@pk/db";

/** 保存形式の先頭。版を上げるときはここを増やす。 */
const ENVELOPE_PREFIX = "pk2fa$v1$";

/** AES-GCM の IV 長（バイト）。96bit は GCM の推奨値。 */
const IV_BYTES = 12;

/** 暗号化鍵の長さ（バイト）。AES-256。 */
const KEY_BYTES = 32;

/** AAD の接頭辞。暗号文を「この担当者の 2FA 秘密」に束縛する。 */
const AAD_PREFIX = "plat2fa:";

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
 * `TWO_FACTOR_ENCRYPTION_KEY` を AES-GCM 鍵にする。
 *
 * **未設定・長さ違いを黙って通さない**（credentials.ts の `importKey()` と
 * 同じ方針）。例外メッセージは名前だけで、値を含めない。
 */
async function importKey(secret: string | undefined): Promise<CryptoKey> {
  if (secret === undefined || secret === "") {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY_MISSING");
  }
  const raw = fromBase64Url(secret);
  if (raw.length !== KEY_BYTES) throw new Error("TWO_FACTOR_ENCRYPTION_KEY_INVALID");
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

function aadFor(operatorId: string): Uint8Array<ArrayBuffer> {
  // `TextEncoder` の戻りは `ArrayBufferLike` 裏付けで DOM の `BufferSource` に
  // 代入できない（pbkdf2.ts の `deriveKey()` と同じ理由）。写して型を確定する。
  return new Uint8Array(new TextEncoder().encode(AAD_PREFIX + operatorId));
}

/**
 * TOTP secret（base32 平文）を封筒にする。DB に入るのは戻り値だけ。
 *
 * IV は呼び出しごとに CSPRNG で作る。`randomBytes` を差し替えられるのは
 * テストのためだけ。**本番で渡さないこと。**
 *
 * @throws {Error} 鍵が未設定・長さ違い（名前だけ。値は含まない）。
 */
export async function sealTotpSecret(
  env: Env,
  operatorId: string,
  plainSecret: string,
  randomBytes: RandomBytes = defaultRandomBytes,
): Promise<string> {
  const key = await importKey(env.TWO_FACTOR_ENCRYPTION_KEY);
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv).buffer,
      additionalData: aadFor(operatorId),
    },
    key,
    new TextEncoder().encode(plainSecret),
  );
  return `${ENVELOPE_PREFIX}${toBase64Url(iv)}$${toBase64Url(new Uint8Array(sealed))}`;
}

/**
 * 封筒を開ける。**読めない理由を区別せず `null`**（形式不正・改竄・鍵違い・
 * 鍵未設定のどれでも同じ）。呼び出し側は認証失敗へ倒し、秘密の状態を
 * 応答に出さない。
 */
export async function openTotpSecret(
  env: Env,
  operatorId: string,
  envelope: string,
): Promise<string | null> {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) return null;
  const [ivPart, cipherPart, ...rest] = envelope.slice(ENVELOPE_PREFIX.length).split("$");
  if (ivPart === undefined || cipherPart === undefined || rest.length > 0) return null;

  try {
    const key = await importKey(env.TWO_FACTOR_ENCRYPTION_KEY);
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(ivPart).buffer as ArrayBuffer,
        additionalData: aadFor(operatorId),
      },
      key,
      fromBase64Url(cipherPart).buffer as ArrayBuffer,
    );
    return new TextDecoder().decode(opened);
  } catch {
    // **区別しない**（上の注記）。ここで投げると応答から秘密の状態が読める。
    return null;
  }
}
