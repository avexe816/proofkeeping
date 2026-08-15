/**
 * PIN ログインのユースケース（現場系 — CLEANER / INSPECTOR）。
 *
 * task:  docs/tasks/P0-09.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #018 / #020 / #021
 *
 * ── 手順 ────────────────────────────────────────────────
 *   1. `orgShortId` → `organizationId`（SHARD_00 の `org_directory`）
 *   2. スタッフ番号 → `user`（組織条件つき）
 *   3. PIN を検証
 *   4. 所属（`membership`）が有効で、PIN を使えるロールかを確認
 *   5. セッションを発行（16 時間 = 1 勤務）
 *
 * `login.ts`（パスワード）と骨格は同じ。**違うのは 3 点だけ:**
 * 通すロール・セッションの長さ・失敗を数えないこと。
 *
 * ── 失敗の理由を返さない ────────────────────────────────
 * 1〜4 のどこで落ちても `AUTH_FAILED` 1 種類で返す（security.md §2）。
 *
 * ── 失敗しても同じだけ時間を使う ────────────────────────
 * 該当が無い場合も `DUMMY_PIN_HASH` に対して 1 回 PBKDF2 を回す。
 * **`login.ts` の `DUMMY_PASSWORD_HASH` を流用しないこと。** あれは
 * 210,000 回なので、PIN 経路で使うと「存在しない利用者への応答だけ 4 倍遅い」
 * という差が出て、かえって存在の有無が読めるようになる。
 *
 * ── HTTP を知らない ─────────────────────────────────────
 * ここはステータスコードもヘッダも扱わない。写像は routes/api/v1/auth.ts。
 * レート制限も呼び出し側（IP を知っているのはハンドラだけ）。
 */

import type { PinLoginRequest } from "@pk/contracts";
import {
  findMembershipByUserId,
  findUserByStaffNumber,
  lookupOrganizationId,
  recordLoginAttempt,
  type Env,
  type RandomBytes,
  type Role,
  type ShardContext,
} from "@pk/db";

import { verifyPin } from "./pin.js";
import { createSession, type CreatedSession } from "./session.js";

/**
 * PIN でログインできるロール（security.md §2 の「現場系」）。
 *
 * `login.ts` の `PASSWORD_LOGIN_ROLES` と裏返しの関係にある。
 * **PIN が設定済みでも、このロールでなければ通さない。** 管理系が PIN で
 * 入れると、4 桁の認証情報で 16 時間のセッションを持ててしまう。
 */
const PIN_LOGIN_ROLES: ReadonlySet<Role> = new Set<Role>(["CLEANER", "INSPECTOR"]);

/**
 * 該当ユーザーが無いときに検証する捨てハッシュ。**反復回数は 50,000。**
 *
 * ランダムな 32 バイトを 16 進で表した文字列から作った。**元の平文は
 * 誰も知らず、記録もしていない。** 一致することはない。
 * `PIN_PBKDF2_PARAMS.iterations` を引き上げたら、この値も作り直して
 * 実行時間を揃えること。**揃えないと timing で存在が読める。**
 */
const DUMMY_PIN_HASH =
  "pbkdf2$sha256$5000$WzfbtkmP9BRK-kuTavB3lg$sr6XFN23bKyZbCWyqWAmrwfqjGewJvWOiY03dsYv-RQ";

/** ログインの結果。**失敗の内訳を持たせない。** */
export type PinLoginResult =
  | { ok: true; session: CreatedSession; pinMustChange: boolean }
  | { ok: false; reason: "AUTH_FAILED" };

const FAILED: PinLoginResult = { ok: false, reason: "AUTH_FAILED" };

export interface PinLoginInput {
  credentials: PinLoginRequest;
  /** 現在時刻。**`Date.now()` を直接呼ばない**（CLAUDE.md §5）。 */
  now: Date;
}

/**
 * PIN でログインを試みる。
 *
 * ── 失敗を数えない ──────────────────────────────────────
 * security.md §2 は「5 回失敗で 15 分ロック」を定めるが、**P0-09 では
 * 実装していない**（task のスコープ外）。現時点で総当たりを止めているのは
 * `/auth/pin-login` の 20 req/分/IP（同 §8）だけ。
 * **`login.ts` の `registerFailure()` に相当するものをここに書かないこと。**
 * 中途半端に数えると、`failedLoginCount` 列をパスワードと共有しているため
 * 「PIN の失敗でパスワードがロックされる」が起きる。実装するなら
 * 列を分けるところから設計する（docs/PROGRESS.md の申し送り）。
 *
 * ただし**既に掛かっているロックは尊重する。** 管理者が別経路で掛けた
 * ロックを PIN で迂回できる状態を作らない。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function pinLogin(
  env: Env,
  input: PinLoginInput,
  randomBytes?: RandomBytes,
): Promise<PinLoginResult> {
  const { orgShortId, staffNumber, pin } = input.credentials;

  const organizationId = await lookupOrganizationId(env, orgShortId);
  if (organizationId === null) {
    await verifyPin(pin, DUMMY_PIN_HASH);
    return FAILED;
  }

  const ctx: ShardContext = { organizationId, orgShortId };
  const found = await findUserByStaffNumber(env, ctx, staffNumber);
  if (found === undefined || found.pinHash === null) {
    await verifyPin(pin, DUMMY_PIN_HASH);
    return FAILED;
  }

  // 判定より先に検証を済ませる。無効化・ロック中でも実行時間を変えないため。
  const pinMatches = await verifyPin(pin, found.pinHash);

  const locked = found.lockedUntil !== null && found.lockedUntil.getTime() > input.now.getTime();
  if (locked) return FAILED;

  if (!found.isActive) return FAILED;
  if (!pinMatches) return FAILED;

  const membership = await findMembershipByUserId(env, ctx, found.id);
  if (membership === undefined || !membership.isActive) return FAILED;
  if (!PIN_LOGIN_ROLES.has(membership.role)) return FAILED;

  // 成功時のみ書く。`failedLoginCount` を 0 に戻すのは、パスワード経路で
  // 積まれた数を現場系の成功で消さないためではなく、**同じ利用者が
  // 両方の経路を持つ運用を想定していない**ため（同時使用チェックは P1）。
  await recordLoginAttempt(env, ctx, {
    userId: found.id,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: input.now,
    now: input.now,
  });

  const session = await createSession(
    env,
    {
      userId: found.id,
      organizationId,
      orgShortId,
      membershipId: membership.id,
      authMethod: "PIN",
      now: input.now,
    },
    randomBytes,
  );

  return { ok: true, session, pinMustChange: found.pinMustChange };
}
