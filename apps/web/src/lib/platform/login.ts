/**
 * プラットフォーム運営のログイン（PK-IMPL-CONTRACT §3.5 / PF-01）。
 *
 * task:  docs/tasks/PF-01.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #220
 *
 * ── 識別子はメール＋パスワード ──────────────────────────
 * 現場系の `orgShortId`＋スタッフ番号は使えない。**運営担当者はどの組織にも
 * 属さない**ので、そもそも組織を解決できない（#220 の 3）。
 * メールの一意性は `platform_operator` が SHARD_00 の 1 か所にしか無いことで
 * 成立する（テナントの `user` と違い組織スコープを持たない）。
 *
 * ── 失敗の理由を返さない ────────────────────────────────
 * 存在しない・パスワードが違う・ロック中・無効化済み — **どこで落ちても
 * `AUTH_FAILED` 1 種類**（security.md §2）。区別できると、運営アカウントの
 * 存在そのものが総当たりの的になる。
 *
 * ── 失敗しても同じだけ時間を使う ────────────────────────
 * 該当が無いとき検証をせずに返すと、応答時間の差から存在の有無が読める。
 * 該当が無い場合も `DUMMY_PASSWORD_HASH` に対して 1 回 PBKDF2 を回す。
 *
 * ── HTTP を知らない ─────────────────────────────────────
 * ステータスコードもヘッダも扱わない。写像は `routes/plat/login.tsx`。
 * レート制限も呼び出し側（IP を知っているのはハンドラだけ）。
 *
 * ── ここで終わらない（PF-17）────────────────────────────
 * パスワードが通っても発行するのは **`PASSWORD_ONLY` の札**で、
 * ログインは第 2 要素（TOTP / 復旧コード）を通って初めて成立する。
 * 第 2 要素は `lib/platform/twoFactor.ts`。
 */

import {
  findPlatformOperatorByEmail,
  recordPlatformLoginAttempt,
  type Env,
  type RandomBytes,
} from "@pk/db";

import { verifyPassword } from "../auth/password.js";

import { auditQuietly, platformAuditId } from "./audit.js";
import { createPlatformSession, type CreatedPlatformSession } from "./session.js";

/** アカウントロックの方針（security.md §2）。**設定項目にしない。** */
export const PLATFORM_LOCK_POLICY = {
  /** 連続 10 回失敗で。 */
  maxFailures: 10,
  /** 30 分ロックする。 */
  lockSeconds: 30 * 60,
} as const;

/**
 * 該当が無いときに検証する捨てハッシュ。
 *
 * **元の平文は誰も知らず、記録もしていない。** 一致することはない。
 * `lib/auth/login.ts` と同じ値を使い回さないのは、片方を作り直したときに
 * もう片方の実行時間だけが変わる状態を避けるため。
 */
const DUMMY_PASSWORD_HASH =
  "pbkdf2$sha256$5000$Rr7wMbHbxvvhcJdJQyvOsw$0kPq2y6cRA2wYbqjZ2SLQWtbfvNJd5B3XmiT5jSjxxE";

/**
 * ログインの結果。**失敗の内訳を持たせない。**
 *
 * 成功はパスワード段階の札（`PASSWORD_ONLY`）で、まだログイン後の画面には
 * 入れない（PF-17）。`requiresEnrollment` が true なら `/plat/2fa/setup` へ、
 * false なら `/plat/2fa` へ送る。判断は呼び出し側（ルート）。
 */
export type PlatformLoginResult =
  | {
      ok: true;
      session: CreatedPlatformSession;
      operatorId: string;
      /** TOTP が未登録（初回）。登録画面へ送ること。 */
      requiresEnrollment: boolean;
    }
  | { ok: false; reason: "AUTH_FAILED" };

const FAILED: PlatformLoginResult = { ok: false, reason: "AUTH_FAILED" };

export interface PlatformLoginInput {
  email: string;
  password: string;
  /** 現在時刻。**`Date.now()` を直接呼ばない**（CLAUDE.md §5）。 */
  now: Date;
  /** 操作元 IP。監査ログの `ip` 列に入る（security.md §6）。 */
  ip?: string | undefined;
  /** 監査ログの ID を作る。テスト以外では既定を使う。 */
  randomBytes?: RandomBytes | undefined;
}

/**
 * ログインする。
 *
 * 手順は 4 つ。**どこで落ちても応答は 1 種類。**
 *   1. メールで運営担当者を引く
 *   2. ロック中・無効化済みでないことを確かめる
 *   3. パスワードを検証する
 *   4. セッションを発行する
 */
export async function platformLogin(
  env: Env,
  input: PlatformLoginInput,
): Promise<PlatformLoginResult> {
  const operator = await findPlatformOperatorByEmail(env, input.email);

  // **該当が無くても 1 回は回す。** 応答時間で存在を読ませない。
  if (operator === null) {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
    return FAILED;
  }

  // ロック中・無効化済み。**検証は行う**（ここで即返すと時間差が出る）。
  const locked =
    operator.lockedUntil !== null && operator.lockedUntil.getTime() > input.now.getTime();
  const suspended = operator.status !== "ACTIVE";
  const verified = await verifyPassword(input.password, operator.passwordHash);

  if (locked || suspended) return FAILED;

  if (!verified) {
    await recordPlatformLoginAttempt(env, {
      operatorId: operator.id,
      success: false,
      now: input.now,
      maxAttempts: PLATFORM_LOCK_POLICY.maxFailures,
      lockMs: PLATFORM_LOCK_POLICY.lockSeconds * 1000,
    });
    // **失敗も記録する。** 運営面の入口は 1 つしか無く、試行の痕跡が
    // 残らないと総当たりに気づけない（テナント面は 5 回目だけ記録するが、
    // こちらは母数が桁違いに小さいので毎回残す）。
    await auditQuietly(env, {
      id: platformAuditId(input.now, input.randomBytes),
      operatorId: operator.id,
      action: "platform.login.failed",
      now: input.now,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
    return FAILED;
  }

  await recordPlatformLoginAttempt(env, {
    operatorId: operator.id,
    success: true,
    now: input.now,
    maxAttempts: PLATFORM_LOCK_POLICY.maxFailures,
    lockMs: PLATFORM_LOCK_POLICY.lockSeconds * 1000,
  });

  // **`platform.login` はここでは書かない。** ログインが成立するのは
  // 第 2 要素を通ったとき（`lib/platform/twoFactor.ts`）。パスワード段階で
  // 書くと、2FA を通れなかった試行が監査上「ログイン成功」に見える。
  const session = await createPlatformSession(env, {
    operatorId: operator.id,
    state: "PASSWORD_ONLY",
    now: input.now,
  });
  return {
    ok: true,
    session,
    operatorId: operator.id,
    requiresEnrollment: operator.twoFactorConfirmedAt === null,
  };
}
