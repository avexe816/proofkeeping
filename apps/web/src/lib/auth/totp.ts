/**
 * TOTP（RFC 6238）。プラットフォーム運営担当者の第 2 要素（PF-17）。
 *
 * task:  docs/tasks/PF-17.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #241
 *
 * ── パラメータは動かさない ──────────────────────────────
 * 30 秒刻み・6 桁・HMAC-SHA1。**設定項目にしない**（PK-IMPL-CONTRACT §11.4）。
 * SHA-1 なのは RFC 6238 の既定で、主要な認証アプリが確実に読めるのが
 * この組み合わせだけのため。ここでの SHA-1 は HMAC の中でしか使わず、
 * 衝突攻撃の影響を受けない（RFC 6194 §2）。
 *
 * ── 時刻は引数で受ける ──────────────────────────────────
 * `Date.now()` を呼ばない（CLAUDE.md §5 と同じ向き）。検証の窓・再利用の
 * 拒否をテストで固定できるのは、時刻が入力になっているからこそ。
 *
 * ── 秘密の扱い ──────────────────────────────────────────
 * base32 の文字列で運ぶ（認証アプリの手入力と otpauth URI の形式）。
 * **この文字列をログ・監査ログ・例外メッセージに載せないこと。**
 */

import type { RandomBytes } from "@pk/db";

import { timingSafeEqual } from "./pbkdf2.js";

/** RFC 4648 の base32 アルファベット。otpauth URI が要求する表記。 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** TOTP のパラメータ。**設定項目にしない。** */
export const TOTP_PARAMS = {
  /** 1 ステップの長さ（秒）。 */
  stepSeconds: 30,
  /** コードの桁数。 */
  digits: 6,
  /** 秘密の長さ（バイト）。RFC 4226 §4 の推奨最小 160 bit。 */
  secretBytes: 20,
  /**
   * 検証で許す前後のステップ数。±1（クロックずれ 30 秒まで）。
   * これ以上広げると、コードの寿命が伸びるだけで利便は上がらない。
   */
  window: 1,
} as const;

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/** バイト列を base32 へ（パディング無し）。 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return output;
}

/**
 * base32 を読む。壊れた値は `null`。**例外を投げない**（検証側で
 * 「不一致」に倒すため / `parsePasswordHash()` と同じ約束）。
 */
export function base32Decode(value: string): Uint8Array | null {
  const normalized = value.toUpperCase().replace(/=+$/, "");
  if (normalized === "") return null;
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/**
 * 秘密を作る（base32 / 32 文字）。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export function generateTotpSecret(randomBytes: RandomBytes = defaultRandomBytes): string {
  return base32Encode(randomBytes(TOTP_PARAMS.secretBytes));
}

/** 時刻（epoch ミリ秒）→ タイムステップ番号。 */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PARAMS.stepSeconds);
}

/**
 * あるステップのコードを計算する（RFC 4226 §5.3 の動的切り出し）。
 *
 * 秘密が base32 として読めなければ `null`。
 */
export async function computeTotpCode(secret: string, step: number): Promise<string | null> {
  const keyBytes = base32Decode(secret);
  if (keyBytes === null || keyBytes.length === 0) return null;

  // カウンタは 64bit big-endian。step は 2^53 未満なので整数除算で 1 バイトずつ出す。
  const counter = new Uint8Array(8);
  let remaining = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }

  const key = await crypto.subtle.importKey(
    "raw",
    // `Uint8Array` → `BufferSource` の写し（pbkdf2.ts の注記と同じ理由）。
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));

  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  const code = binary % 10 ** TOTP_PARAMS.digits;
  return String(code).padStart(TOTP_PARAMS.digits, "0");
}

/**
 * コードを検証する。**一致したステップ番号**を返し、不一致は `null`。
 *
 * 前後 `window` ステップを許す。呼び出し側は返ったステップを保存し、
 * **保存済み以下のステップを拒むこと**（同じコードの 2 回目を通さない /
 * RFC 6238 §5.2）。比較は定数時間（`timingSafeEqual`）。**一致しても
 * ループを最後まで回す** — どのステップで一致したかを実行時間に出さない。
 */
export async function verifyTotpCode(
  secret: string,
  code: string,
  nowMs: number,
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = totpStep(nowMs);
  const encoder = new TextEncoder();
  const given = encoder.encode(code);

  let matched: number | null = null;
  for (let offset = -TOTP_PARAMS.window; offset <= TOTP_PARAMS.window; offset++) {
    const step = currentStep + offset;
    if (step < 0) continue;
    const expected = await computeTotpCode(secret, step);
    if (expected === null) return null;
    if (timingSafeEqual(encoder.encode(expected), given)) matched ??= step;
  }
  return matched;
}

/**
 * 認証アプリへ渡す otpauth URI（QR に載せる）。
 *
 * **この文字列は秘密を含む。** 画面の QR と手入力欄以外に出さないこと。
 */
export function buildOtpauthUri(secret: string, accountName: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_PARAMS.digits),
    period: String(TOTP_PARAMS.stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
