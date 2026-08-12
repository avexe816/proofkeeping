/**
 * パスワードログインのユースケース。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #018 / #019 / #020
 *
 * ── 手順 ────────────────────────────────────────────────
 *   1. `orgShortId` → `organizationId`（SHARD_00 の `org_directory`）
 *   2. スタッフ番号 → `user`（組織条件つき）
 *   3. パスワードを検証
 *   4. 所属（`membership`）が有効で、パスワードを使えるロールかを確認
 *   5. セッションを発行
 *
 * ── 失敗の理由を返さない ────────────────────────────────
 * 1〜4 のどこで落ちても `AUTH_FAILED` 1 種類で返す（security.md §2）。
 * 「組織は在る」「その番号の人は在る」が分かるだけで、総当たりの的が絞れる。
 *
 * ── 失敗しても同じだけ時間を使う ────────────────────────
 * 組織やスタッフ番号が存在しないとき、検証をせずに即座に返すと
 * **応答時間の差から存在の有無が読める。** そこで該当が無い場合も
 * `DUMMY_PASSWORD_HASH` に対して 1 回だけ PBKDF2 を回す。
 *
 * ── HTTP を知らない ─────────────────────────────────────
 * ここはステータスコードもヘッダも扱わない。写像は routes/api/v1/auth.ts。
 * レート制限も呼び出し側（IP を知っているのはハンドラだけ）。
 */

import type { LoginRequest } from "@pk/contracts";
import {
  findMembershipByUserId,
  findUserByStaffNumber,
  lookupOrganizationId,
  recordAudit,
  recordLoginAttempt,
  type Env,
  type RandomBytes,
  type Role,
  type ShardContext,
  type TenantContext,
} from "@pk/db";

import { verifyPassword } from "./password.js";
import { createSession, type CreatedSession } from "./session.js";

/**
 * パスワードでログインできるロール（security.md §2 の「管理系」）。
 *
 * `CLEANER` / `INSPECTOR` は PIN でログインする（P0-09）。
 * **パスワードが設定済みでも、このロールでなければ通さない。**
 * ロールごとに認証方式と有効期限（12 時間 / 16 時間）が対応しているため、
 * 現場系がパスワードで入ると 1 勤務より長いセッションを持ててしまう。
 */
const PASSWORD_LOGIN_ROLES: ReadonlySet<Role> = new Set<Role>([
  "OWNER",
  "ORG_ADMIN",
  "PROPERTY_MANAGER",
  "VENDOR_ADMIN",
  "AUDITOR",
]);

/** アカウントロックの方針（security.md §2）。**設定項目にしない。** */
export const PASSWORD_LOCK_POLICY = {
  /** 連続 10 回失敗で。 */
  maxFailures: 10,
  /** 30 分ロックする。 */
  lockSeconds: 30 * 60,
} as const;

/**
 * 監査ログを書く失敗回数（security.md §6「ログイン失敗（5 回目のみ）」）。
 *
 * **ロックの閾値（10 回）と別の数字であることに意味がある。** ロックの
 * 半分の時点で 1 件だけ残すことで、「総当たりが始まっている」ことは追えて、
 * かつ 1 回のログイン失敗ごとに 1 行増える形（打ち間違いで埋まる）にはしない。
 * **`PASSWORD_LOCK_POLICY.maxFailures` に揃えないこと。**
 */
export const PASSWORD_FAILURE_AUDIT_AT = 5;

/**
 * 該当ユーザーが無いときに検証する捨てハッシュ。
 *
 * ランダムな 32 バイトを 16 進で表した文字列から作った。**元の平文は
 * 誰も知らず、記録もしていない。** 一致することはない。
 * パラメータを引き上げたら、この値も作り直して実行時間を揃えること。
 */
const DUMMY_PASSWORD_HASH =
  "pbkdf2$sha256$210000$KHvyuYyA_a0GksfFBmCIRw$GAZf4qN4Yib8IDqPWRuPtfSp2DA6fNCOzFuLaUlAhgA";

/** ログインの結果。**失敗の内訳を持たせない。** */
export type LoginResult =
  | { ok: true; session: CreatedSession }
  | { ok: false; reason: "AUTH_FAILED" };

const FAILED: LoginResult = { ok: false, reason: "AUTH_FAILED" };

export interface LoginInput {
  credentials: LoginRequest;
  /** 現在時刻。**`Date.now()` を直接呼ばない**（CLAUDE.md §5）。 */
  now: Date;
  /**
   * 操作元 IP。監査ログの `ip` 列に入る（security.md §6）。
   *
   * IP を知っているのはハンドラだけなので引数で受け取る（レート制限と同じ）。
   * 省略しても認証の判定は変わらない。
   */
  ip?: string | undefined;
}

/**
 * ログイン失敗の監査ログを書く（security.md §6）。
 *
 * ── なぜここで `membership` を引くのか ───────────────────
 * `auditLog` は `actorId`（membership ID）と `actorRole` を NOT NULL で持つ。
 * ログイン失敗の時点では所属をまだ引いていないため、ここで 1 回だけ引く。
 * **`PASSWORD_FAILURE_AUDIT_AT` 回目の失敗でしか呼ばれない**ので、
 * 通常のログインにも、総当たりの各試行にも D1 の読み取りは増えない。
 *
 * 所属が無いユーザー（招待の途中など）は記録しない。誰の操作として
 * 残すかを決められず、`actorId` に偽の値を入れるほうが証跡として有害。
 *
 * ── 組み立てる `TenantContext` について ─────────────────
 * `allowedPropertyIds` は空で渡す。`recordAudit()` は INSERT だけを行い、
 * 施設スコープの絞り込み（`scopeToProperties()`）を通らないため参照されない。
 * **この文脈を他のリポジトリ関数へ渡さないこと。** 空配列は
 * 「担当施設なし」を意味し、読み取りに使うと 0 件になる。
 *
 * ── 監査の失敗で認証を壊さない ──────────────────────────
 * 例外を飲む。ここで投げると、監査ログが書けないときに**ログインの応答が
 * 500 になり、失敗の理由が応答から読める**（`AUTH_FAILED` 一本の原則が崩れる）。
 */
async function auditLoginFailure(
  env: Env,
  ctx: ShardContext,
  input: { userId: string; now: Date; ip?: string | undefined },
): Promise<void> {
  try {
    const membership = await findMembershipByUserId(env, ctx, input.userId);
    if (membership === undefined) return;

    const auditCtx: TenantContext = {
      ...ctx,
      role: membership.role,
      allowedPropertyIds: [],
      now: input.now,
    };
    await recordAudit(env, auditCtx, {
      actorId: membership.id,
      action: "auth.loginFailed",
      targetType: "user",
      targetId: input.userId,
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
  } catch {
    // 監査ログの書き込み失敗はログインの判定に影響させない。
  }
}

/**
 * 失敗を記録し、必要ならロックする。
 *
 * ロックが切れていたら数え直す。**切れたロックを引きずらない。**
 * 上限に達したらロック時刻を入れ、カウンタは 0 に戻す
 * （解除後にまた `maxFailures` 回の猶予を与える）。
 */
async function registerFailure(
  env: Env,
  ctx: ShardContext,
  input: {
    userId: string;
    failedLoginCount: number;
    lockedUntil: Date | null;
    now: Date;
    ip?: string | undefined;
  },
): Promise<void> {
  const lockExpired = input.lockedUntil !== null && input.lockedUntil.getTime() <= input.now.getTime();
  const base = lockExpired ? 0 : input.failedLoginCount;
  const next = base + 1;
  const reachedLimit = next >= PASSWORD_LOCK_POLICY.maxFailures;

  await recordLoginAttempt(env, ctx, {
    userId: input.userId,
    failedLoginCount: reachedLimit ? 0 : next,
    lockedUntil: reachedLimit
      ? new Date(input.now.getTime() + PASSWORD_LOCK_POLICY.lockSeconds * 1000)
      : lockExpired
        ? null
        : input.lockedUntil,
    now: input.now,
  });

  // security.md §6「ログイン失敗（5 回目のみ）」。**`next` で判定する。**
  // 保存後の値（上限到達で 0 に戻る）で見ると 5 回目を取り逃す。
  if (next === PASSWORD_FAILURE_AUDIT_AT) {
    await auditLoginFailure(env, ctx, { userId: input.userId, now: input.now, ip: input.ip });
  }
}

/**
 * ログインを試みる。
 *
 * `randomBytes` を差し替えられるのはテストのためだけ。**本番で渡さないこと。**
 */
export async function login(
  env: Env,
  input: LoginInput,
  randomBytes?: RandomBytes,
): Promise<LoginResult> {
  const { orgShortId, staffNumber, password } = input.credentials;

  const organizationId = await lookupOrganizationId(env, orgShortId);
  if (organizationId === null) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return FAILED;
  }

  const ctx: ShardContext = { organizationId, orgShortId };
  const found = await findUserByStaffNumber(env, ctx, staffNumber);
  if (found === undefined || found.passwordHash === null) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return FAILED;
  }

  // 判定より先に検証を済ませる。無効化・ロック中でも実行時間を変えないため。
  const passwordMatches = await verifyPassword(password, found.passwordHash);

  const locked = found.lockedUntil !== null && found.lockedUntil.getTime() > input.now.getTime();
  // ロック中は数え上げない。総当たりでロックを延長できてしまうため。
  if (locked) return FAILED;

  if (!found.isActive) return FAILED;

  if (!passwordMatches) {
    await registerFailure(env, ctx, {
      userId: found.id,
      failedLoginCount: found.failedLoginCount,
      lockedUntil: found.lockedUntil,
      now: input.now,
      ip: input.ip,
    });
    return FAILED;
  }

  const membership = await findMembershipByUserId(env, ctx, found.id);
  if (membership === undefined || !membership.isActive) return FAILED;
  if (!PASSWORD_LOGIN_ROLES.has(membership.role)) return FAILED;

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
      authMethod: "PASSWORD",
      now: input.now,
    },
    randomBytes,
  );

  return { ok: true, session };
}
