/**
 * 運営面で第 2 要素を要求するか（PF-19 / DECISIONS #250）。
 *
 * task: docs/tasks/PF-19.md
 * 手順: docs/runbook/platform-bootstrap.md §10
 *
 * ── なぜ在るか ──────────────────────────────────────────
 * staging で TOTP の登録が繰り返し通らず、運営画面へ入れないままになった。
 * **実装を消すのではなく、要求するかどうかだけを切り替える。**
 * 消すと戻すのが高くつき（破壊的 migration が要る）、段階を 1 つに畳むと
 * 権限判定に穴が出る。ここで切るのは**「誰に `COMPLETE` の札を出すか」だけ。**
 *
 * ── 門は畳まない ────────────────────────────────────────
 * `requirePlatformOperator()` の `state !== "COMPLETE"` は**残す。**
 * 切り替え前に発行された `PASSWORD_ONLY` の札は、`false` にしても通らない。
 *
 * ── production は var を読まない ────────────────────────
 * `ENVIRONMENT === "production"` のときは値を見ずに `true`。
 * **設定ファイルの取り違え 1 回で本番の 2FA が外れる形を残さない**
 * （wrangler.toml と runbook の記述だけに頼らない / #250 決定 C）。
 */

import type { Env } from "@pk/db";

/** この関数が読む env。**`Env` 全体を要求しない**（検査で作りやすくする）。 */
export type TwoFactorPolicyEnv = Pick<Env, "PLATFORM_2FA_REQUIRED" | "ENVIRONMENT">;

/**
 * 第 2 要素を要求するか。**既定は要求する。**
 *
 * `false` になるのは、production 以外で `PLATFORM_2FA_REQUIRED` が
 * ちょうど `"false"` のときだけ。空・未設定・綴り違いはすべて `true`
 * （**読めない設定を「無効化」と解さない**）。
 */
export function isPlatformTwoFactorRequired(env: TwoFactorPolicyEnv): boolean {
  if (env.ENVIRONMENT === "production") return true;
  return env.PLATFORM_2FA_REQUIRED !== "false";
}
