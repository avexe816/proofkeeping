/**
 * 必須 secret の検査。**設定漏れを、原因の読める形で落とす。**
 *
 * task:  docs/tasks/P2-06.md（実機で通しに回らなかった原因の 3 つ目）
 * ルール: .claude/rules/architecture.md §1（ログに内訳を出さない範囲）
 *
 * ── 何が起きていたか ────────────────────────────────────
 * `apps/web/.dev.vars` を作らずに `pnpm dev` を起動すると
 * `env.SESSION_SECRET` が空文字になる。空文字は
 * `crypto.subtle.importKey()` が **`Zero-length key is not supported`** で
 * 弾くため、ログインが `INTERNAL_ERROR`（500）で落ちる。
 * **応答にも例外にも「secret が無い」と書いていない**ので、ローカルの
 * 立ち上げで必ず詰まり、原因に辿り着くまでが長い。
 *
 * ── 直し方の方針 ────────────────────────────────────────
 * 「空鍵でも動くようにする」ではない（それは鍵の無い署名を許すこと）。
 * **要求は変えず、断り方を変える。** 足りない名前を挙げて 503 を返し、
 * 直し方（`.dev.vars.example` をコピーする）を添える。
 *
 * ── 値を出さない ────────────────────────────────────────
 * **応答にもログにも secret の値を載せない。** 出すのは**名前だけ。**
 * 「設定されているか」は名前だけで十分に伝わる。
 */

import type { Env } from "@pk/db";

/** 1 つの secret と、それが無いと何が動かないか。 */
export interface RequiredSecret {
  name: keyof Env;
  /** 無いときに壊れる経路。**メッセージに出す。** */
  purpose: string;
}

/**
 * 起動に必須の secret。**「あると良い」ものを入れないこと。**
 *
 * 判断の基準は「無いと**普通の操作が 500 で落ちる**か」。
 *   - `SESSION_SECRET` … 全リクエストのセッション照合と署名付き URL。落ちる
 *   - `RESEND_API_KEY` … メール送信（P2 では送らない）。**入れない**
 *   - `CREDENTIAL_ENCRYPTION_KEY` … 外部連携（P6）。**入れない**
 *   - `SENTRY_DSN` … 任意。`.dev.vars.example` も空。**入れない**
 *
 * 使い始める task が 1 行足すこと。**前倒しで必須にすると、その機能を
 * 使わない開発者の環境が理由なく起動しなくなる。**
 */
export const REQUIRED_SECRETS: readonly RequiredSecret[] = [
  {
    name: "SESSION_SECRET",
    purpose: "セッション Cookie の署名と写真の署名付き URL",
  },
];

/**
 * 足りない secret の**名前**を返す。空配列なら揃っている。
 *
 * 空白だけの値も「無い」として扱う。`SESSION_SECRET=" "` は HMAC の鍵
 * としては通ってしまい、**設定したつもりの間違いが動いてしまう**ほうが
 * 見つけにくい。
 */
export function missingSecretNames(env: Partial<Env>): string[] {
  return REQUIRED_SECRETS.filter((secret) => {
    const value: unknown = env[secret.name];
    return typeof value !== "string" || value.trim() === "";
  }).map((secret) => secret.name);
}

/**
 * 人が読む説明。**直し方まで書く。**
 *
 * `wrangler` のローカル実行と Cloudflare 上とで直し方が違うので両方出す。
 */
export function missingSecretsMessage(names: readonly string[]): string {
  const list = names.join(", ");
  return [
    `必須の設定が未設定です: ${list}`,
    "",
    "ローカル: cp apps/web/.dev.vars.example apps/web/.dev.vars",
    "Cloudflare: wrangler secret put <NAME>",
  ].join("\n");
}
