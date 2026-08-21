/**
 * プラットフォーム運営のリポジトリ。**SHARD_00 のみ。**
 *
 * task: docs/tasks/PF-01.md
 * 決定: docs/DECISIONS.md #220
 * ルール: .claude/rules/security.md §2（認証）・§6（監査ログ）
 *
 * ── `TenantContext` を取らない ──────────────────────────
 * 運営担当者はどの組織にも属さない（#220 の 3）。テナントの文脈が無いので
 * `withTenantScope()` も `assertIdBelongsToTenant()` も通らない。
 * **代わりに `getPlatformDb()` しか使わない**ことが分離の担保になる —
 * 返る DB のスキーマに `task` も `room` も載っていないため、
 * ここからテナントのデータへは型として到達できない。
 *
 * ── 記録は足すだけ ──────────────────────────────────────
 * `platform_audit_log` に UPDATE / DELETE の関数を作らない（INV-30 と同じ）。
 * 訂正は新しい行を足す。**運営が自分の痕跡を消せる形にしない。**
 * `repositories.spec.ts` がこの表への更新・削除が無いことを固定している。
 *
 * ── 失敗の理由を持ち出さない ────────────────────────────
 * `findPlatformOperatorByEmail()` は行をそのまま返す。**ロック中・無効を
 * 呼び出し側で区別して応答を変えないこと**（security.md §2 の
 * 「認証の失敗応答を一律にする」）。判断は `lib/platform/login.ts`。
 */

import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { getPlatformDb } from "../router.js";
import {
  platformAuditLog,
  platformBootstrapToken,
  platformOperationSetting,
  platformOperator,
  platformRecoveryCode,
  platformTenantSnapshot,
  type PlatformOperatorStatus,
} from "../schema/platform.js";

/**
 * 運営担当者の 1 行。**`passwordHash` を呼び出し側の外へ出さないこと。**
 * **`twoFactorSecret` も同じ扱い**（PF-17。ログ・応答・監査ログへ出さない）。
 */
export interface PlatformOperatorRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  status: PlatformOperatorStatus;
  failedAttempts: number;
  lockedUntil: Date | null;
  /** TOTP の共有秘密の封筒（`pk2fa$…`）。`null` は登録が始まっていない。 */
  twoFactorSecret: string | null;
  /** TOTP の登録が確認できた時刻。**`null` は未登録**（PF-17）。 */
  twoFactorConfirmedAt: Date | null;
  twoFactorFailedAttempts: number;
  twoFactorLockedUntil: Date | null;
  /** 直前に受理した TOTP のタイムステップ。再利用の拒否に使う。 */
  twoFactorLastStep: number | null;
}

/**
 * メールで 1 件引く。**照合は完全一致。**
 *
 * 大文字小文字を畳まないのは、畳む規則を勝手に決めないため
 * （登録時に正規化するかは PF-02 以降の運用の話 / OPEN_QUESTIONS へ）。
 */
export async function findPlatformOperatorByEmail(
  env: Env,
  email: string,
): Promise<PlatformOperatorRow | null> {
  const rows = await getPlatformDb(env)
    .select(OPERATOR_COLUMNS)
    .from(platformOperator)
    .where(eq(platformOperator.email, email))
    .limit(1);
  return rows[0] ?? null;
}

/** `id` で 1 件引く（セッションから復元するとき）。 */
export async function findPlatformOperatorById(
  env: Env,
  id: string,
): Promise<PlatformOperatorRow | null> {
  const rows = await getPlatformDb(env)
    .select(OPERATOR_COLUMNS)
    .from(platformOperator)
    .where(eq(platformOperator.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** 2 つの find が同じ列を返すための共通指定。 */
const OPERATOR_COLUMNS = {
  id: platformOperator.id,
  email: platformOperator.email,
  displayName: platformOperator.displayName,
  passwordHash: platformOperator.passwordHash,
  status: platformOperator.status,
  failedAttempts: platformOperator.failedAttempts,
  lockedUntil: platformOperator.lockedUntil,
  twoFactorSecret: platformOperator.twoFactorSecret,
  twoFactorConfirmedAt: platformOperator.twoFactorConfirmedAt,
  twoFactorFailedAttempts: platformOperator.twoFactorFailedAttempts,
  twoFactorLockedUntil: platformOperator.twoFactorLockedUntil,
  twoFactorLastStep: platformOperator.twoFactorLastStep,
} as const;

/** `recordPlatformLoginAttempt()` の入力。 */
export interface PlatformLoginAttemptInput {
  operatorId: string;
  success: boolean;
  now: Date;
  /** ロックまでの失敗回数（security.md §2 は 10 回）。 */
  maxAttempts: number;
  /** ロックの長さ（ミリ秒）。security.md §2 は 30 分。 */
  lockMs: number;
}

/**
 * ログインの成否を記録する。
 *
 * 成功で失敗回数とロックを消し、失敗で 1 加算する。**加算は SQL 側で行う**
 * （読んで足して書くと、同時に走った試行のぶんが取りこぼされる）。
 * 上限に達した試行でロック時刻を書く。
 */
export async function recordPlatformLoginAttempt(
  env: Env,
  input: PlatformLoginAttemptInput,
): Promise<void> {
  const db = getPlatformDb(env);
  if (input.success) {
    await db
      .update(platformOperator)
      .set({ failedAttempts: 0, lockedUntil: null, updatedAt: input.now })
      .where(eq(platformOperator.id, input.operatorId));
    return;
  }

  await db
    .update(platformOperator)
    .set({
      failedAttempts: sql`${platformOperator.failedAttempts} + 1`,
      // **上限に達した試行でだけロックする。** 毎回書くと、失敗のたびに
      // 30 分が伸びる（総当たりの体感が変わらない一方で、正規の利用者が
      // 締め出され続ける）。
      lockedUntil: sql`CASE WHEN ${platformOperator.failedAttempts} + 1 >= ${input.maxAttempts}
        THEN ${input.now.getTime() + input.lockMs} ELSE ${platformOperator.lockedUntil} END`,
      updatedAt: input.now,
    })
    .where(eq(platformOperator.id, input.operatorId));
}

/**
 * TOTP の登録を始める（PF-17）。**封筒（暗号文）**を書き、未確認の状態に戻す。
 *
 * 受け取るのは `sealTotpSecret()`（`lib/platform/totpSecretBox.ts`）が
 * 封をした自己記述文字列だけ。**base32 の平文をこの関数に渡さないこと**
 * （DECISIONS #244 — D1 に平文を置かない）。
 *
 * `twoFactorConfirmedAt` を消すのは、確認前に離脱して再開したときに
 * 「新しい秘密＋確認済み」という嘘の状態を作らないため。**確認済みの
 * 担当者には効かない**（WHERE の `IS NULL` 条件 — 盗んだパスワードだけで
 * 2FA を掛け替えさせない）。
 */
export async function savePlatformTwoFactorSecret(
  env: Env,
  input: { operatorId: string; sealedSecret: string; now: Date },
): Promise<void> {
  await getPlatformDb(env)
    .update(platformOperator)
    .set({
      twoFactorSecret: input.sealedSecret,
      twoFactorConfirmedAt: null,
      twoFactorLastStep: null,
      updatedAt: input.now,
    })
    .where(and(eq(platformOperator.id, input.operatorId), isNull(platformOperator.twoFactorConfirmedAt)));
}

/**
 * TOTP の登録を確認済みにする（PF-17）。**通ったかどうかを返す。**
 *
 * `two_factor_confirmed_at IS NULL` を条件に含めた UPDATE で、同じ担当者への
 * 同時確認は**片方だけ**が `true` を得る。負けた側は登録済みへの再確認 =
 * 失敗として扱うこと（復旧コードとセッションを二重に発行させない）。
 * 検証に通った試行のタイムステップも同時に書き、登録に使ったコードの
 * 再利用をここで塞ぐ。
 */
export async function confirmPlatformTwoFactor(
  env: Env,
  input: { operatorId: string; lastStep: number; now: Date },
): Promise<boolean> {
  const result = await getPlatformDb(env)
    .update(platformOperator)
    .set({
      twoFactorConfirmedAt: input.now,
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
      twoFactorLastStep: input.lastStep,
      updatedAt: input.now,
    })
    .where(
      and(eq(platformOperator.id, input.operatorId), isNull(platformOperator.twoFactorConfirmedAt)),
    );
  return result.meta.changes > 0;
}

/**
 * 受理する TOTP のタイムステップを**原子的に**消費する（PF-17）。
 *
 * `two_factor_last_step IS NULL OR two_factor_last_step < ?` を条件に含めた
 * UPDATE で、**同じコードを載せた並行リクエストは片方だけ**が `true` を得る。
 * アプリ側で読んで比べてから書くと、読みが交差した 2 本が両方通る
 * （それを塞ぐのがこの関数。呼び出し側は `false` を「同一または過去
 * ステップの再利用」= 認証失敗として扱い、**`true` のときだけ**セッションを
 * 発行し `platform.login` を書くこと）。
 *
 * 成功は第 2 要素の成功でもあるので、失敗回数とロックもここで消す。
 */
export async function consumePlatformTotpStep(
  env: Env,
  input: { operatorId: string; matchedStep: number; now: Date },
): Promise<boolean> {
  const result = await getPlatformDb(env)
    .update(platformOperator)
    .set({
      twoFactorLastStep: input.matchedStep,
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(platformOperator.id, input.operatorId),
        or(
          isNull(platformOperator.twoFactorLastStep),
          lt(platformOperator.twoFactorLastStep, input.matchedStep),
        ),
      ),
    );
  return result.meta.changes > 0;
}

/** `recordPlatformTwoFactorAttempt()` の入力。 */
export interface PlatformTwoFactorAttemptInput {
  operatorId: string;
  success: boolean;
  now: Date;
  /** ロックまでの失敗回数（PIN と同じ 5 回 / security.md §2）。 */
  maxAttempts: number;
  /** ロックの長さ（ミリ秒）。PIN と同じ 15 分。 */
  lockMs: number;
}

/**
 * 第 2 要素の成否を記録する。**数え方は `recordPlatformLoginAttempt()` と同じ。**
 *
 * 成功で失敗回数とロックを消し、失敗で 1 加算する。加算は SQL 側
 * （読んで足して書くと同時試行を取りこぼす）。上限に達した試行でだけ
 * ロック時刻を書く。
 *
 * **タイムステップはここでは書かない。** TOTP の成功は
 * `consumePlatformTotpStep()` / `confirmPlatformTwoFactor()` が条件付き
 * UPDATE で消費する（この関数の成功経路を使うのは復旧コードだけ）。
 */
export async function recordPlatformTwoFactorAttempt(
  env: Env,
  input: PlatformTwoFactorAttemptInput,
): Promise<void> {
  const db = getPlatformDb(env);
  if (input.success) {
    await db
      .update(platformOperator)
      .set({
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: null,
        updatedAt: input.now,
      })
      .where(eq(platformOperator.id, input.operatorId));
    return;
  }

  await db
    .update(platformOperator)
    .set({
      twoFactorFailedAttempts: sql`${platformOperator.twoFactorFailedAttempts} + 1`,
      twoFactorLockedUntil: sql`CASE WHEN ${platformOperator.twoFactorFailedAttempts} + 1 >= ${input.maxAttempts}
        THEN ${input.now.getTime() + input.lockMs} ELSE ${platformOperator.twoFactorLockedUntil} END`,
      updatedAt: input.now,
    })
    .where(eq(platformOperator.id, input.operatorId));
}

/** 復旧コード 1 本（ハッシュのみ）。**平文を受け取る型を作らない。** */
export interface PlatformRecoveryCodeInput {
  /** `plat_rc_{…}`。呼び出し側が決める（監査と突き合わせるため）。 */
  id: string;
  /** SHA-256（小文字 16 進 64 桁）。 */
  codeHash: string;
}

/**
 * 復旧コードを一式入れ替える（発行・再発行 / PF-17）。
 *
 * 未使用の既存コードを `revokedAt` で失効させてから新しいハッシュを入れる。
 * **行は消さない**（使用済み・失効済みの痕跡を監査で追えるようにする）。
 */
export async function replacePlatformRecoveryCodes(
  env: Env,
  input: { operatorId: string; codes: readonly PlatformRecoveryCodeInput[]; now: Date },
): Promise<void> {
  const db = getPlatformDb(env);
  await db
    .update(platformRecoveryCode)
    .set({ revokedAt: input.now })
    .where(
      and(
        eq(platformRecoveryCode.operatorId, input.operatorId),
        isNull(platformRecoveryCode.usedAt),
        isNull(platformRecoveryCode.revokedAt),
      ),
    );
  if (input.codes.length === 0) return;
  await db.insert(platformRecoveryCode).values(
    input.codes.map((code) => ({
      id: code.id,
      operatorId: input.operatorId,
      codeHash: code.codeHash,
      createdAt: input.now,
      usedAt: null,
      revokedAt: null,
    })),
  );
}

/** 有効な復旧コード（未使用・未失効）のハッシュを引く。 */
export async function listActivePlatformRecoveryCodes(
  env: Env,
  operatorId: string,
): Promise<{ id: string; codeHash: string }[]> {
  return getPlatformDb(env)
    .select({ id: platformRecoveryCode.id, codeHash: platformRecoveryCode.codeHash })
    .from(platformRecoveryCode)
    .where(
      and(
        eq(platformRecoveryCode.operatorId, operatorId),
        isNull(platformRecoveryCode.usedAt),
        isNull(platformRecoveryCode.revokedAt),
      ),
    );
}

/**
 * 復旧コードを 1 本消費する。**1 本 1 回**（PF-17 の完了条件）。
 *
 * `usedAt IS NULL` を条件に含めた UPDATE で、同じ行への同時消費は
 * 片方だけが `true` を得る。`false` は「既に使われていた」。
 */
export async function consumePlatformRecoveryCode(
  env: Env,
  input: { id: string; operatorId: string; now: Date },
): Promise<boolean> {
  const result = await getPlatformDb(env)
    .update(platformRecoveryCode)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(platformRecoveryCode.id, input.id),
        eq(platformRecoveryCode.operatorId, input.operatorId),
        isNull(platformRecoveryCode.usedAt),
        isNull(platformRecoveryCode.revokedAt),
      ),
    );
  return result.meta.changes > 0;
}

/** `recordPlatformAudit()` の入力。**個人情報を `detail` に入れない。** */
export interface PlatformAuditInput {
  id: string;
  /** 主体が定まらない操作（ログイン失敗など）は `null`。 */
  operatorId: string | null;
  action: string;
  targetOrganizationId?: string | null | undefined;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  detail?: Record<string, unknown> | undefined;
  ip?: string | null | undefined;
  now: Date;
}

/**
 * 運営面の操作を記録する。**足すだけ。**
 *
 * 更新・削除の関数をこのファイルに作らないこと（INV-30 と同じ扱い）。
 */
export async function recordPlatformAudit(env: Env, input: PlatformAuditInput): Promise<void> {
  await getPlatformDb(env)
    .insert(platformAuditLog)
    .values({
      id: input.id,
      operatorId: input.operatorId,
      action: input.action,
      targetOrganizationId: input.targetOrganizationId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ip: input.ip ?? null,
      createdAt: input.now,
    });
}

/** `createPlatformOperator()` の入力。**`id` は呼び出し側が決める。** */
export interface CreatePlatformOperatorInput {
  /** `plat_op_{ulid}`。シードが決定的な値を渡せるように外から受ける。 */
  id: string;
  email: string;
  displayName: string;
  /** PBKDF2-SHA256 210,000 回の自己記述文字列（security.md §2）。 */
  passwordHash: string;
  now: Date;
}

/**
 * 運営担当者を作る。
 *
 * **呼び出し元はシード（local / staging）だけ。** 招待の画面はまだ無い
 * （PF-14 の担当）。同じメールが既にあれば何もしない — シードが
 * 3 回流れても 1 行のままにするため（testing.md §4）。
 *
 * **無効化は `status` で行う。DELETE の関数を作らない**（監査ログの
 * `operator_id` が指す先を消さない / このファイル冒頭の注記）。
 */
export async function createPlatformOperator(
  env: Env,
  input: CreatePlatformOperatorInput,
): Promise<void> {
  await getPlatformDb(env)
    .insert(platformOperator)
    .values({
      id: input.id,
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      status: "ACTIVE",
      failedAttempts: 0,
      lockedUntil: null,
      twoFactorSecret: null,
      // **未登録で作る。** 初回ログインで TOTP の登録を通る（PF-17）。
      twoFactorConfirmedAt: null,
      twoFactorFailedAttempts: 0,
      twoFactorLockedUntil: null,
      twoFactorLastStep: null,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing();
}

/**
 * 運営担当者を**最初の 1 名としてだけ**作る（PF-16 / DECISIONS #245）。
 *
 * **これが「1 人目だけ」の保証そのもの。** 呼び出し側が件数を数えてから
 * INSERT すると、数えた後・書く前に交差した 2 本が両方通る（そのときに
 * 出来上がるのは「2 人の 1 人目」で、あとから消す口も無い）。
 *
 * `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM platform_operator)` は
 * D1（SQLite）で 1 文＝1 トランザクションとして走るので、**存在検査と挿入の
 * 間に他の書き込みが入れない。** 同時に走った 2 本のうち `changes = 1` を
 * 取れるのは 1 本だけで、負けた側は `false` を受け取る。
 *
 * 戻り値が `false` のときは**既に運営担当者が居る**。呼び出し側は開通を
 * 失敗として扱うこと（券は既に消費済みでよい — 巻き戻すと、負けた側が
 * 券を持ったまま再試行できてしまう）。
 *
 * **パスワードは呼び出し側がハッシュ化して渡す。** 平文をこの層へ入れない。
 * 2FA は未登録で作る（初回ログインで登録を通る / PF-17）。
 */
export async function createFirstPlatformOperator(
  env: Env,
  input: {
    id: string;
    email: string;
    displayName: string;
    /** PBKDF2-SHA256 の自己記述文字列（security.md §2）。**平文を渡さない。** */
    passwordHash: string;
    now: Date;
  },
): Promise<boolean> {
  const at = input.now.getTime();
  const result = await getPlatformDb(env).run(sql`
    INSERT INTO ${platformOperator}
      (${sql.raw(platformOperator.id.name)}, ${sql.raw(platformOperator.email.name)},
       ${sql.raw(platformOperator.displayName.name)}, ${sql.raw(platformOperator.passwordHash.name)},
       ${sql.raw(platformOperator.status.name)}, ${sql.raw(platformOperator.failedAttempts.name)},
       ${sql.raw(platformOperator.twoFactorFailedAttempts.name)},
       ${sql.raw(platformOperator.createdAt.name)}, ${sql.raw(platformOperator.updatedAt.name)})
    SELECT ${input.id}, ${input.email}, ${input.displayName}, ${input.passwordHash},
           'ACTIVE', 0, 0, ${at}, ${at}
    WHERE NOT EXISTS (SELECT 1 FROM ${platformOperator})
  `);
  return result.meta.changes > 0;
}

/**
 * 運営担当者が 1 名でも居るか（PF-16 の要件 7）。
 *
 * **これは早い段階で断るための検査であって、保証ではない。** 保証は
 * `createFirstPlatformOperator()` の条件付き INSERT が持つ。ここで見るのは
 * 「券を出す前に、明らかに要らないと分かる場合を断る」ため。
 */
export async function platformOperatorExists(env: Env): Promise<boolean> {
  const rows = await getPlatformDb(env)
    .select({ id: platformOperator.id })
    .from(platformOperator)
    .limit(1);
  return rows.length > 0;
}

/** 初期開通の券 1 枚（PF-16）。**平文の token を持つ型を作らない。** */
export interface PlatformBootstrapTokenRow {
  id: string;
  email: string;
  displayName: string;
  expiresAt: Date;
}

/**
 * 券を 1 枚作る（PF-16）。**受け取るのはハッシュだけ。**
 *
 * 平文の token をこの層へ渡さないこと（`lib/platform/bootstrap.ts` が
 * 作ってメール 1 通に載せ、以後どこにも残さない）。
 */
export async function createPlatformBootstrapToken(
  env: Env,
  input: {
    id: string;
    email: string;
    displayName: string;
    /** SHA-256（小文字 16 進 64 桁）。 */
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  },
): Promise<void> {
  await getPlatformDb(env).insert(platformBootstrapToken).values({
    id: input.id,
    email: input.email,
    displayName: input.displayName,
    tokenHash: input.tokenHash,
    createdAt: input.now,
    expiresAt: input.expiresAt,
    usedAt: null,
    revokedAt: null,
  });
}

/**
 * 有効な券をハッシュで 1 枚引く（PF-16）。**未使用・未失効・期限内だけ。**
 *
 * 見つからない理由（無い・使用済み・失効・期限切れ）を**区別して返さない。**
 * 呼び出し側が応答を分けられない形にしておく（要件「期限切れ、使用済み、
 * 不正 token は同じ失敗応答にする」）。
 */
export async function findActivePlatformBootstrapToken(
  env: Env,
  input: { tokenHash: string; now: Date },
): Promise<PlatformBootstrapTokenRow | null> {
  const rows = await getPlatformDb(env)
    .select({
      id: platformBootstrapToken.id,
      email: platformBootstrapToken.email,
      displayName: platformBootstrapToken.displayName,
      expiresAt: platformBootstrapToken.expiresAt,
    })
    .from(platformBootstrapToken)
    .where(
      and(
        eq(platformBootstrapToken.tokenHash, input.tokenHash),
        isNull(platformBootstrapToken.usedAt),
        isNull(platformBootstrapToken.revokedAt),
        gt(platformBootstrapToken.expiresAt, input.now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 券を**原子的に**1 回だけ消費する（PF-16）。
 *
 * 有効条件（未使用・未失効・期限内）を WHERE に畳み込んだ UPDATE で、
 * **同じ券を載せた並行リクエストは片方だけ**が `true` を得る。
 * `consumePlatformRecoveryCode()` と同じ形 — 引いて確かめてから書くと、
 * 読みが交差した 2 本が両方通る。
 *
 * `false` は「無い・使用済み・失効・期限切れ」のいずれか。**区別しない。**
 */
export async function consumePlatformBootstrapToken(
  env: Env,
  input: { tokenHash: string; now: Date },
): Promise<boolean> {
  const result = await getPlatformDb(env)
    .update(platformBootstrapToken)
    .set({ usedAt: input.now })
    .where(
      and(
        eq(platformBootstrapToken.tokenHash, input.tokenHash),
        isNull(platformBootstrapToken.usedAt),
        isNull(platformBootstrapToken.revokedAt),
        gt(platformBootstrapToken.expiresAt, input.now),
      ),
    );
  return result.meta.changes > 0;
}

/**
 * 未使用の券をすべて失効させる（PF-16）。**行は消さない。**
 *
 * 再発行の前と、送信に失敗した券の後始末に使う。**古い券を生かしたまま
 * 刷り増さない** — 有効な開通リンクが同時に 2 本ある状態を作らない。
 */
export async function revokePlatformBootstrapTokens(env: Env, now: Date): Promise<void> {
  await getPlatformDb(env)
    .update(platformBootstrapToken)
    .set({ revokedAt: now })
    .where(
      and(isNull(platformBootstrapToken.usedAt), isNull(platformBootstrapToken.revokedAt)),
    );
}

/**
 * 運用設定の 1 行の `id`（PF-14 / `platform_operation_setting`）。
 *
 * **1 行しか持たない表**なので固定値で引く（schema/platform.ts の注記）。
 */
export const PLATFORM_SETTING_ID = "plat_setting_singleton";

/** 運用（変更可）の 5 項目。**PF-14 の表と 1 対 1。増やさない。** */
export interface PlatformOperationSettings {
  inputDurationFloorSeconds: number;
  defaultRateThresholdPercent: number;
  photoRetentionDays: number;
  roomsPerStaffLimit: number;
  maintenanceStartJst: string;
  maintenanceEndJst: string;
}

/**
 * 既定値。**ここが唯一の出どころ。**
 *
 * 表の `default()` と同じ値を持たせてあるのは、**行がまだ無いとき**に
 * 読み手が同じ値を得るため（SQLite の既定値は INSERT のときしか効かない）。
 * 値は PF-14 の表（既定 10 秒 / 70% / 90 日 / 16 室 / 03:00〜04:00）。
 */
export const PLATFORM_OPERATION_DEFAULTS: PlatformOperationSettings = {
  inputDurationFloorSeconds: 10,
  defaultRateThresholdPercent: 70,
  photoRetentionDays: 90,
  roomsPerStaffLimit: 16,
  maintenanceStartJst: "03:00",
  maintenanceEndJst: "04:00",
};

/**
 * 運用設定を読む。**行が無ければ既定値。**
 *
 * 読み手（PF-02 / PF-05）が「未設定」を意識しなくてよい形にする。
 * **書き込みの関数はここに無い** — 変更は申請と承認 2 名を通る
 * （PF-14 の担当）。
 */
export async function readPlatformOperationSettings(
  env: Env,
): Promise<PlatformOperationSettings> {
  const rows = await getPlatformDb(env)
    .select({
      inputDurationFloorSeconds: platformOperationSetting.inputDurationFloorSeconds,
      defaultRateThresholdPercent: platformOperationSetting.defaultRateThresholdPercent,
      photoRetentionDays: platformOperationSetting.photoRetentionDays,
      roomsPerStaffLimit: platformOperationSetting.roomsPerStaffLimit,
      maintenanceStartJst: platformOperationSetting.maintenanceStartJst,
      maintenanceEndJst: platformOperationSetting.maintenanceEndJst,
    })
    .from(platformOperationSetting)
    .where(eq(platformOperationSetting.id, PLATFORM_SETTING_ID))
    .limit(1);
  return rows[0] ?? PLATFORM_OPERATION_DEFAULTS;
}

/** スナップショット 1 行ぶんの値（PF-02）。**割合と判定を含めない。** */
export interface TenantSnapshotInput {
  organizationId: string;
  businessDate: string;
  name: string;
  plan: string | null;
  subscriptionStatus: string | null;
  contractedOn: string | null;
  trialEndsOn: string | null;
  propertyCount: number;
  roomCount: number;
  billableRoomCount: number;
  staffCount: number;
  completedTasks: number;
  observationsRecorded: number;
  observationsSkipped: number;
  observationsUsedDefaults: number;
  inputDurationMedianMs: number | null;
  // ── 3 つとも `null` を取る。**`null` は「未計測」** ────────
  // 0033 より前の行はこの 3 つを数えていない。**`?? 0` で 0 に落とさない**
  // （未計測を「実測 0 件」に見せない / schema/platform.ts の注記）。
  /** その業務日に記録された差異の数（PF-05）。`null` は未計測。 */
  findingsHigh: number | null;
  /** その業務日にアップロードされた写真の枚数（PF-05）。`null` は未計測。 */
  photoCount: number | null;
  /** 表示言語ごとの人数（PF-05）。**誰が何語かは持たない。** `null` は未計測。 */
  localeCounts: Record<string, number> | null;
  now: Date;
}

/**
 * スナップショットを 1 行書く（PF-02）。**再計算方式の UPSERT。**
 *
 * 差分を足さない。数え直した値でそのまま上書きする（architecture.md §3）。
 * **3 回流しても結果が変わらない**（testing.md §4）。`id` は組織と業務日から
 * 決まる形にしてあるので、衝突時に別 ID の行が増えることもない。
 */
export async function upsertTenantSnapshot(
  env: Env,
  input: TenantSnapshotInput,
): Promise<void> {
  const values = {
    organizationId: input.organizationId,
    businessDate: input.businessDate,
    name: input.name,
    plan: input.plan,
    subscriptionStatus: input.subscriptionStatus,
    contractedOn: input.contractedOn,
    trialEndsOn: input.trialEndsOn,
    propertyCount: input.propertyCount,
    roomCount: input.roomCount,
    billableRoomCount: input.billableRoomCount,
    staffCount: input.staffCount,
    completedTasks: input.completedTasks,
    observationsRecorded: input.observationsRecorded,
    observationsSkipped: input.observationsSkipped,
    observationsUsedDefaults: input.observationsUsedDefaults,
    inputDurationMedianMs: input.inputDurationMedianMs,
    findingsHigh: input.findingsHigh,
    photoCount: input.photoCount,
    localeCounts: input.localeCounts,
    updatedAt: input.now,
  };

  await getPlatformDb(env)
    .insert(platformTenantSnapshot)
    .values({ id: tenantSnapshotId(input.organizationId, input.businessDate), ...values })
    .onConflictDoUpdate({
      target: [platformTenantSnapshot.organizationId, platformTenantSnapshot.businessDate],
      set: values,
    });
}

/**
 * スナップショットの `id`。**組織と業務日から決まる。**
 *
 * ランダムにすると、一意制約で弾かれた 2 回目が「別 ID の行を作ろうとして
 * 落ちた」のか「同じ行を更新した」のか読めなくなる（シードの ID を
 * 決定的にしてあるのと同じ理由）。
 */
function tenantSnapshotId(organizationId: string, businessDate: string): string {
  return `plat_snap_${organizationId}_${businessDate}`;
}

/** スナップショット 1 行（読み出し）。書き込みの `now` が `updatedAt` になる。 */
export type TenantSnapshotRow = Omit<TenantSnapshotInput, "now"> & { updatedAt: Date };

/**
 * ある業務日のスナップショットを全テナントぶん読む（PF-04 / PF-05 が使う）。
 *
 * **これはテナント横断の読み出しだが、`getTenantDb()` を通っていない。**
 * 読んでいるのは SHARD_00 の運営面の表だけで、テナントの表には触れない
 * （#220 の 2 — 横断はスナップショット経由でだけ成立する）。
 */
export async function listTenantSnapshots(
  env: Env,
  businessDate: string,
): Promise<TenantSnapshotRow[]> {
  return getPlatformDb(env)
    .select({
      organizationId: platformTenantSnapshot.organizationId,
      businessDate: platformTenantSnapshot.businessDate,
      name: platformTenantSnapshot.name,
      plan: platformTenantSnapshot.plan,
      subscriptionStatus: platformTenantSnapshot.subscriptionStatus,
      contractedOn: platformTenantSnapshot.contractedOn,
      trialEndsOn: platformTenantSnapshot.trialEndsOn,
      propertyCount: platformTenantSnapshot.propertyCount,
      roomCount: platformTenantSnapshot.roomCount,
      billableRoomCount: platformTenantSnapshot.billableRoomCount,
      staffCount: platformTenantSnapshot.staffCount,
      completedTasks: platformTenantSnapshot.completedTasks,
      observationsRecorded: platformTenantSnapshot.observationsRecorded,
      observationsSkipped: platformTenantSnapshot.observationsSkipped,
      observationsUsedDefaults: platformTenantSnapshot.observationsUsedDefaults,
      inputDurationMedianMs: platformTenantSnapshot.inputDurationMedianMs,
      findingsHigh: platformTenantSnapshot.findingsHigh,
      photoCount: platformTenantSnapshot.photoCount,
      localeCounts: platformTenantSnapshot.localeCounts,
      updatedAt: platformTenantSnapshot.updatedAt,
    })
    .from(platformTenantSnapshot)
    .where(eq(platformTenantSnapshot.businessDate, businessDate))
    .orderBy(platformTenantSnapshot.name);
}

/**
 * スナップショットが在る最新の業務日（PF-04 / PF-05）。無ければ `null`。
 *
 * 画面が「今日」を決め打ちで引くと、**夜間バッチがまだ回っていない朝に
 * 空の一覧が出る。** 在る中でいちばん新しい日を使い、その日付を画面に出す。
 */
export async function findLatestSnapshotDate(env: Env): Promise<string | null> {
  const rows = await getPlatformDb(env)
    .select({ businessDate: platformTenantSnapshot.businessDate })
    .from(platformTenantSnapshot)
    .orderBy(desc(platformTenantSnapshot.businessDate))
    .limit(1);
  return rows[0]?.businessDate ?? null;
}
