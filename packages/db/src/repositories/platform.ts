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

import { eq, sql } from "drizzle-orm";

import type { Env } from "../env.js";
import { getPlatformDb } from "../router.js";
import {
  platformAuditLog,
  platformOperator,
  type PlatformOperatorStatus,
} from "../schema/platform.js";

/** 運営担当者の 1 行。**`passwordHash` を呼び出し側の外へ出さないこと。** */
export interface PlatformOperatorRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  status: PlatformOperatorStatus;
  failedAttempts: number;
  lockedUntil: Date | null;
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
    .select({
      id: platformOperator.id,
      email: platformOperator.email,
      displayName: platformOperator.displayName,
      passwordHash: platformOperator.passwordHash,
      status: platformOperator.status,
      failedAttempts: platformOperator.failedAttempts,
      lockedUntil: platformOperator.lockedUntil,
    })
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
    .select({
      id: platformOperator.id,
      email: platformOperator.email,
      displayName: platformOperator.displayName,
      passwordHash: platformOperator.passwordHash,
      status: platformOperator.status,
      failedAttempts: platformOperator.failedAttempts,
      lockedUntil: platformOperator.lockedUntil,
    })
    .from(platformOperator)
    .where(eq(platformOperator.id, id))
    .limit(1);
  return rows[0] ?? null;
}

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
