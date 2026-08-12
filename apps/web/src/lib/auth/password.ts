/**
 * パスワードのハッシュ化と検証。
 *
 * task:  docs/tasks/P0-08.md（機構の抽出は P0-09）
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
 * ── 機構は pbkdf2.ts にある ─────────────────────────────
 * 保存形式・ソルト・定数時間比較は PIN と共有する（P0-09 / DECISIONS #021）。
 * **このファイルが持つのはパスワード用のパラメータと、その周りの規則だけ。**
 * `PBKDF2_PARAMS` を pbkdf2.ts へ移さないこと。あれは「パスワードの
 * 反復回数」であって共有物ではない（PIN は 50,000 回）。
 */

import type { RandomBytes } from "@pk/db";

import {
  hashSecret,
  needsRehash as needsRehashWith,
  parseStoredHash,
  verifySecret,
  type ParsedPbkdf2Hash,
  type Pbkdf2Params,
} from "./pbkdf2.js";

/**
 * パスワードの現行パラメータ。**設定項目にしない**（docs/PK-IMPL-CONTRACT.md §11.4）。
 * 引き上げにはリリースを要する状態を維持する。
 */
export const PBKDF2_PARAMS: Pbkdf2Params = {
  algorithm: "pbkdf2",
  hash: "sha256",
  /** OWASP の PBKDF2-HMAC-SHA256 推奨（600,000 回）は実測 103ms で CPU 予算を超える。 */
  iterations: 210_000,
  saltBytes: 16,
  /** SHA-256 の出力長に合わせる。これ以上伸ばしても強度は上がらない。 */
  keyBytes: 32,
} as const;

/** 定数時間比較。実体は pbkdf2.ts。**独自に書き直さないこと。** */
export { timingSafeEqual } from "./pbkdf2.js";

/**
 * 保存形式の文字列を作る。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function hashPassword(
  password: string,
  randomBytes?: RandomBytes,
): Promise<string> {
  return randomBytes === undefined
    ? hashSecret(password, PBKDF2_PARAMS)
    : hashSecret(password, PBKDF2_PARAMS, randomBytes);
}

/** 壊れた値・別方式は `null`。**例外を投げない**（検証側で「不一致」に倒すため）。 */
export function parsePasswordHash(stored: string): ParsedPbkdf2Hash | null {
  return parseStoredHash(stored);
}

/**
 * 平文と保存値を照合する。
 *
 * 解析できない値は `false`。**「ハッシュが壊れているから通す」を作らない。**
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  return verifySecret(password, stored);
}

/**
 * 現行パラメータで作り直すべきか。
 *
 * 反復回数を引き上げたあと、ログイン成功時にだけ呼んで段階移行する。
 * **移行のためにパスワードの再設定を利用者へ求めない。**
 */
export function needsRehash(stored: string): boolean {
  return needsRehashWith(stored, PBKDF2_PARAMS);
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
