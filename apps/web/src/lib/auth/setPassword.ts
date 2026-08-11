/**
 * パスワードの設定。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §2
 *
 * ── なぜ API ではなく関数なのか ─────────────────────────
 * P0 にパスワードの変更・リセット画面を持つ task が無い（P0-14 は UI シェル、
 * P0-18 は seed）。エンドポイントを勝手に作らず、**ポリシー検査と
 * 再利用禁止をひとまとめにした関数**として置く。seed と、将来の変更画面が使う。
 *
 * ── ここを迂回して `setPasswordHash()` を直接呼ばない ────
 * 直接呼ぶと 10 文字以上のポリシーと直近 3 世代の再利用禁止が両方外れる。
 * リポジトリ層は渡されたハッシュを書くだけで、判定を持っていない。
 */

import { passwordSchema } from "@pk/contracts";
import {
  listRecentPasswordHashes,
  setPasswordHash,
  type Env,
  type RandomBytes,
  type TenantContext,
} from "@pk/db";

import { hashPassword, isPasswordReused } from "./password.js";

/**
 * 失敗の理由。**利用者に返す文言はここで決めない**（UI の i18n キー経由）。
 *
 * ログインと違い、こちらは理由を返してよい。既に本人が認証済みの経路で、
 * 「なぜ設定できないか」が分からないと直しようがないため。
 */
export type SetPasswordResult =
  | { ok: true }
  | { ok: false; reason: "POLICY_VIOLATION" | "REUSED" };

export interface SetUserPasswordInput {
  userId: string;
  /** 平文。**ログ・監査ログ・例外メッセージへ出さないこと。** */
  newPassword: string;
}

/**
 * パスワードを設定する。ポリシー検査 → 再利用検査 → 保存の順。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function setUserPassword(
  env: Env,
  ctx: TenantContext,
  input: SetUserPasswordInput,
  randomBytes?: RandomBytes,
): Promise<SetPasswordResult> {
  if (!passwordSchema.safeParse(input.newPassword).success) {
    return { ok: false, reason: "POLICY_VIOLATION" };
  }

  const recent = await listRecentPasswordHashes(env, ctx, input.userId);
  if (await isPasswordReused(input.newPassword, recent)) {
    return { ok: false, reason: "REUSED" };
  }

  const passwordHash =
    randomBytes === undefined
      ? await hashPassword(input.newPassword)
      : await hashPassword(input.newPassword, randomBytes);
  await setPasswordHash(env, ctx, { userId: input.userId, passwordHash });
  return { ok: true };
}
