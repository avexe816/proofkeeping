/**
 * ユーザー・所属・施設割当のリポジトリ。
 *
 * task: docs/tasks/P0-07.md
 * ルール: .claude/rules/security.md §1 / §5
 *
 * ── 認証ブートストラップの 4 関数 ───────────────────────
 * `findUserByStaffNumber` / `findMembershipByUserId` / `listAssignedPropertyIds` /
 * `recordLoginAttempt` だけが `ShardContext` を取る。
 * `TenantContext` を組み立てるための情報（ロールと担当施設）を引く関数と、
 * **そもそも認証が成立していない時点で動く関数**なので、`TenantContext` を
 * 要求すると循環する（docs/DECISIONS.md #016 / #018）。
 * **この 4 つ以外を `ShardContext` にしないこと。** 施設スコープが掛からなくなる。
 * repositories.spec.ts が「ブートストラップ関数はこの 4 つだけ」を固定している。
 *
 * 4 つとも `assertIdBelongsToTenant()` または `withOrganizationScope()` を通り、
 * 組織の外へは出られない。緩めているのは**施設**スコープだけで、
 * テナント分離そのものは緩めていない。
 *
 * ── 保存しないもの ──────────────────────────────────────
 * ここで扱うのは従業員の情報のみ。宿泊者の情報は存在しない（security.md §3）。
 * `passwordHash` / `pinHash` を監査ログや API レスポンスへ載せないこと（同 §6）。
 * この層は行をそのまま返すため、**マスクは呼び出し側の責務**。
 */

import { desc, eq, notInArray } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type ShardContext, type TenantContext } from "../router.js";
import { membership, passwordHistory, propertyAssignment, user, type Role } from "../schema/user.js";

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
 * **認証ブートストラップ専用。** スタッフ番号からユーザーを 1 件引く（P0-08）。
 *
 * `staffNumber` は組織内で unique（`uq_user_org_staff_number`）なので高々 1 件。
 * ID ではなく利用者が入力する値なので `assertIdBelongsToTenant()` は掛からない。
 * **越境は組織条件が防ぐ**（`ctx.organizationId` は `orgShortId` から
 * `org_directory` 経由で解決した値であり、リクエストの値ではない）。
 *
 * 無効化されたユーザー（`isActive = false`）も返す。ログインを拒むのは
 * 呼び出し側の判断で、ここでは事実だけを返す。**返り値には
 * `passwordHash` / `pinHash` が含まれる。API レスポンスや監査ログへ載せないこと。**
 */
export async function findUserByStaffNumber(env: Env, ctx: ShardContext, staffNumber: string) {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(user)
    .where(withOrganizationScope(user, ctx, eq(user.staffNumber, staffNumber)))
    .limit(1);
  return rows[0];
}

/**
 * **認証ブートストラップ専用。** ログイン試行の結果を書く（P0-08）。
 *
 * **ロックの方針（何回で何分）はここに持たせない。** 呼び出し側
 * （`apps/web/src/lib/auth/login.ts`）が決めた値をそのまま書く。
 * リポジトリ層に閾値を置くと、パスワード 10 回 / PIN 5 回の違いを
 * ここで分岐することになり、認証方式が増えるたびに DB 層が変わる。
 */
export interface LoginAttemptInput {
  userId: string;
  /** 連続失敗回数。成功なら 0 を渡す。 */
  failedLoginCount: number;
  /** ロック解除時刻。ロックしない・解除するなら null。 */
  lockedUntil: Date | null;
  /** 成功時のみ渡す。失敗では最終ログイン時刻を動かさない。 */
  lastLoginAt?: Date | undefined;
  /** 現在時刻。`updatedAt` に入れる（リポジトリで `Date.now()` を呼ばない）。 */
  now: Date;
}

export async function recordLoginAttempt(env: Env, ctx: ShardContext, input: LoginAttemptInput) {
  assertIdBelongsToTenant(input.userId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(user)
    .set({
      failedLoginCount: input.failedLoginCount,
      lockedUntil: input.lockedUntil,
      ...(input.lastLoginAt === undefined ? {} : { lastLoginAt: input.lastLoginAt }),
      updatedAt: input.now,
    })
    .where(withOrganizationScope(user, ctx, eq(user.id, input.userId)));
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

/**
 * 施設に割り当てられたスタッフ（W-04 人員配分 / PK-SPEC-P1 §4）。
 *
 * task: docs/tasks/P1-14.md
 *
 * ── 認証情報を返さない ──────────────────────────────────
 * `passwordHash` / `pinHash` を選ばない（security.md §6）。**行をそのまま
 * 返す他の関数と違い、ここは列を明示している。** 人員配分の画面は
 * 一覧をそのままレスポンスへ載せるので、行を返すと認証情報が外へ出る。
 *
 * ── 誰を出すかは呼び出し側 ──────────────────────────────
 * ロールで絞らずに返す。§4.1 の「出勤スタッフ」を表すデータ（シフト）は
 * P8 の Workforce まで存在せず、ここで `CLEANER` だけに絞ると
 * 施設責任者が自分で持つ客室を配分できない。**絞るなら画面が絞る。**
 */
export interface PropertyStaff {
  membershipId: string;
  userId: string;
  role: Role;
  staffNumber: string;
  displayName: string;
}

export async function listPropertyStaff(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
): Promise<PropertyStaff[]> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({
      membershipId: membership.id,
      userId: user.id,
      role: membership.role,
      staffNumber: user.staffNumber,
      displayName: user.displayName,
    })
    .from(propertyAssignment)
    .innerJoin(membership, eq(membership.id, propertyAssignment.membershipId))
    .innerJoin(user, eq(user.id, membership.userId))
    .where(
      withTenantScope(
        propertyAssignment,
        ctx,
        propertyAssignment.propertyId,
        eq(propertyAssignment.propertyId, propertyId),
        eq(propertyAssignment.isActive, true),
        eq(membership.isActive, true),
        eq(user.isActive, true),
      ),
    );

  // スタッフ番号が未設定の行はログインできない（`findUserByStaffNumber` の
  // 注記）。配分の対象にしても現場に届かないので落とす。
  return rows.flatMap((row) =>
    row.staffNumber === null
      ? []
      : [{ ...row, staffNumber: row.staffNumber }],
  );
}

/**
 * 表示言語を変える（PK-SPEC-P1 §12.3 / M-11 の設定）。
 *
 * task: docs/tasks/P1-18.md
 *
 * **ブラウザの言語設定は参照しない**（ui-writing.md §1）。共用端末で
 * 誤動作するため、ユーザー属性として保存し、ログイン直後から適用する。
 * 値が対応言語かの判定は呼び出し側（`isLocale()`）。
 */
export async function setUserLocale(
  env: Env,
  ctx: TenantContext,
  userId: string,
  locale: string,
): Promise<void> {
  assertIdBelongsToTenant(userId, ctx);
  const db = await getTenantDb(env, ctx);
  await db
    .update(user)
    .set({ locale, updatedAt: ctx.now })
    .where(withTenantScope(user, ctx, NO_PROPERTY_SCOPE, eq(user.id, userId)));
}

/**
 * 再利用を禁止する世代数（security.md §2「直近 3 世代の再利用禁止」）。
 *
 * **設定項目にしない。** 変更にリリースを要する状態を維持する
 * （docs/PK-IMPL-CONTRACT.md §11.4 の方針）。
 */
export const PASSWORD_HISTORY_GENERATIONS = 3;

/**
 * 直近のパスワードハッシュを新しい順に返す（P0-08）。
 *
 * 再利用の照合にだけ使う。**返り値をレスポンス・ログ・監査ログへ出さないこと。**
 */
export async function listRecentPasswordHashes(
  env: Env,
  ctx: TenantContext,
  userId: string,
  limit: number = PASSWORD_HISTORY_GENERATIONS,
): Promise<string[]> {
  assertIdBelongsToTenant(userId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ passwordHash: passwordHistory.passwordHash })
    .from(passwordHistory)
    .where(
      withTenantScope(
        passwordHistory,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(passwordHistory.userId, userId),
      ),
    )
    .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id))
    .limit(limit);
  return rows.map((row) => row.passwordHash);
}

/** `setPasswordHash()` の入力。**平文を渡さない。** ハッシュ化は認証層の責務。 */
export interface SetPasswordHashInput {
  userId: string;
  /** `pbkdf2$sha256$...` 形式（docs/DECISIONS.md #019）。 */
  passwordHash: string;
}

/**
 * パスワードハッシュを差し替え、世代を記録する（P0-08）。
 *
 * ── 呼ぶ前に再利用を確認すること ────────────────────────
 * **この関数は再利用の判定をしない。** 判定は
 * `apps/web/src/lib/auth/password.ts` の `assertPasswordNotReused()` が行う。
 * ハッシュはソルトを含むため、同じ平文でも文字列が一致せず、
 * SQL の比較では判定できない（1 世代ずつ `verify` する必要がある）。
 *
 * ── 古い世代を残さない ──────────────────────────────────
 * 照合に要るのは直近 `PASSWORD_HISTORY_GENERATIONS` 世代だけ。
 * それ以前を残しても価値が無く、漏洩時に総当たりの的が増えるだけなので削る。
 * 操作の証跡は `AuditLog`（P0-11）が持つ。
 */
export async function setPasswordHash(
  env: Env,
  ctx: TenantContext,
  input: SetPasswordHashInput,
): Promise<void> {
  assertIdBelongsToTenant(input.userId, ctx);
  const db = await getTenantDb(env, ctx);

  await db
    .update(user)
    .set({
      passwordHash: input.passwordHash,
      passwordUpdatedAt: ctx.now,
      updatedAt: ctx.now,
    })
    .where(withTenantScope(user, ctx, NO_PROPERTY_SCOPE, eq(user.id, input.userId)));

  await db.insert(passwordHistory).values({
    id: generateId(ctx.orgShortId, "pwh"),
    organizationId: ctx.organizationId,
    userId: input.userId,
    passwordHash: input.passwordHash,
    createdAt: ctx.now,
  });

  const keep = await db
    .select({ id: passwordHistory.id })
    .from(passwordHistory)
    .where(
      withTenantScope(
        passwordHistory,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(passwordHistory.userId, input.userId),
      ),
    )
    .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id))
    .limit(PASSWORD_HISTORY_GENERATIONS);

  // 残す世代が上限に満たないなら、削る対象はそもそも存在しない。
  // notInArray に空配列を渡さないためでもある（drizzle の挙動がバージョン依存）。
  if (keep.length < PASSWORD_HISTORY_GENERATIONS) return;

  await db.delete(passwordHistory).where(
    withTenantScope(
      passwordHistory,
      ctx,
      NO_PROPERTY_SCOPE,
      eq(passwordHistory.userId, input.userId),
      notInArray(
        passwordHistory.id,
        keep.map((row) => row.id),
      ),
    ),
  );
}
