/**
 * ユーザー・所属・施設割当のリポジトリ。
 *
 * task: docs/tasks/P0-07.md
 * ルール: .claude/rules/security.md §1 / §5
 *
 * ── 認証ブートストラップの 2 関数 ───────────────────────
 * `findMembershipByUserId` と `listAssignedPropertyIds` だけが `ShardContext` を取る。
 * `TenantContext` を組み立てるための情報（ロールと担当施設）を引く関数なので、
 * `TenantContext` を要求すると循環する（docs/DECISIONS.md #016）。
 * **この 2 つ以外を `ShardContext` にしないこと。** 施設スコープが掛からなくなる。
 * repositories.spec.ts が「ブートストラップ関数はこの 2 つだけ」を固定している。
 *
 * ── 保存しないもの ──────────────────────────────────────
 * ここで扱うのは従業員の情報のみ。宿泊者の情報は存在しない（security.md §3）。
 * `passwordHash` / `pinHash` を監査ログや API レスポンスへ載せないこと（同 §6）。
 * この層は行をそのまま返すため、**マスクは呼び出し側の責務**。
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant } from "../id.js";
import { getTenantDb, type ShardContext, type TenantContext } from "../router.js";
import { membership, propertyAssignment, user } from "../schema/user.js";

import { NO_PROPERTY_SCOPE, withOrganizationScope, withTenantScope } from "./base.js";

/** `listUsers()` の絞り込み。未指定の項目は条件に加えない。 */
export interface UserFilter {
  /** 無効化済みを除くなら `true`。既定は全件（無効も含む）。 */
  isActive?: boolean | undefined;
}

/**
 * 組織のユーザー一覧。
 *
 * `user` は施設列を持たないため施設スコープは掛からない。
 * 施設スコープロールがこの一覧へ到達してよいかは P0-10 が判定する
 * （OPEN_QUESTIONS #016）。
 */
export async function listUsers(env: Env, ctx: TenantContext, filter: UserFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(user)
    .where(
      withTenantScope(
        user,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.isActive === undefined ? undefined : eq(user.isActive, filter.isActive),
      ),
    );
}

/** ユーザー 1 件。越境 ID は DB へ行く前に `NotFoundError`（→ 404）。 */
export async function findUserById(env: Env, ctx: TenantContext, userId: string) {
  assertIdBelongsToTenant(userId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(user)
    .where(withTenantScope(user, ctx, NO_PROPERTY_SCOPE, eq(user.id, userId)))
    .limit(1);
  return rows[0];
}

/**
 * **認証ブートストラップ専用。** ユーザーの所属とロールを引く。
 *
 * `membership` は組織 × ユーザーで unique なので高々 1 件。
 * 無効化された所属（`isActive = false`）も返す。ログインを拒むのは
 * 呼び出し側（P0-08）の判断で、ここでは事実だけを返す。
 */
export async function findMembershipByUserId(env: Env, ctx: ShardContext, userId: string) {
  assertIdBelongsToTenant(userId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(membership)
    .where(withOrganizationScope(membership, ctx, eq(membership.userId, userId)))
    .limit(1);
  return rows[0];
}

/**
 * **認証ブートストラップ専用。** `TenantContext.allowedPropertyIds` の中身を作る。
 *
 * 無効化された割当（`isActive = false`）は除く。担当を外れた施設が
 * 見えたままになるのを防ぐ。**戻り値が空配列なら「担当施設なし」であって
 * 「全施設」ではない**（`scopeToProperties()` がその意味で扱う）。
 */
export async function listAssignedPropertyIds(
  env: Env,
  ctx: ShardContext,
  membershipId: string,
): Promise<string[]> {
  assertIdBelongsToTenant(membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ propertyId: propertyAssignment.propertyId })
    .from(propertyAssignment)
    .where(
      withOrganizationScope(
        propertyAssignment,
        ctx,
        eq(propertyAssignment.membershipId, membershipId),
        eq(propertyAssignment.isActive, true),
      ),
    );
  return rows.map((row) => row.propertyId);
}
