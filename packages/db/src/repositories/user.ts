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

import { and, count, desc, eq, notInArray } from "drizzle-orm";

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
 * 組織のスタッフ全員ぶんの施設割当（W-07 スタッフ管理の「主な担当施設」）。
 *
 * task: プロトタイプ ops 07
 *
 * ── 1 回で引く ──────────────────────────────────────────
 * `listAssignedPropertyIds()` は 1 人ぶん。台帳の画面は 30 人を超えるので、
 * 人数ぶん呼ぶと D1 への往復がそのまま増える。**組織ぶんを 1 クエリで返し、
 * 画面側で `membershipId` に畳む。**
 *
 * 無効化された割当（`isActive = false`）は返さない。担当を外れた施設が
 * 一覧に出続けるのを防ぐ（`listAssignedPropertyIds()` と同じ扱い）。
 */
export interface StaffPropertyAssignment {
  membershipId: string;
  propertyId: string;
}

export async function listStaffPropertyAssignments(
  env: Env,
  ctx: TenantContext,
): Promise<StaffPropertyAssignment[]> {
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      membershipId: propertyAssignment.membershipId,
      propertyId: propertyAssignment.propertyId,
    })
    .from(propertyAssignment)
    .where(
      withTenantScope(
        propertyAssignment,
        ctx,
        propertyAssignment.propertyId,
        eq(propertyAssignment.isActive, true),
      ),
    );
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

/** 組織のスタッフ 1 人（P8-01）。**認証情報を含めない。** */
export interface OrgStaff {
  membershipId: string;
  userId: string;
  role: Role;
  /** ログインできない（未設定の）行もあるので `null` を許す。 */
  staffNumber: string | null;
  displayName: string;
  locale: string;
  isActive: boolean;
}

/**
 * 組織のスタッフ一覧（P8-01 / プロトタイプ ops 07）。
 *
 * ── `listUsers()` を使わない理由 ────────────────────────
 * あれは行をそのまま返すので `passwordHash` / `pinHash` が付いてくる。
 * 一覧はレスポンスへそのまま載るため、**列を明示する**
 * （`listPropertyStaff()` と同じ判断 / security.md §6）。
 *
 * ── 施設で絞らない ──────────────────────────────────────
 * `user` / `membership` は `propertyId` を持たず、`scopeToProperties()` が
 * 掛からない（`user.read` は施設スコープロールも組織全体 /
 * OPEN_QUESTIONS #016）。担当施設での絞りは呼び出し側。
 *
 * **無効化済みも返す。** 「退職者を含めて 31 名」と「稼働中 28 名」を
 * 同じ一覧から数えるため。落とすのは画面側。
 */
export async function listOrgStaff(env: Env, ctx: TenantContext): Promise<OrgStaff[]> {
  const db = await getTenantDb(env, ctx);
  return db
    .select({
      membershipId: membership.id,
      userId: user.id,
      role: membership.role,
      staffNumber: user.staffNumber,
      displayName: user.displayName,
      locale: user.locale,
      isActive: membership.isActive,
    })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(withTenantScope(membership, ctx, NO_PROPERTY_SCOPE))
    .orderBy(user.staffNumber);
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

/**
 * 所属の開始時刻（P2-02 / PK-SPEC-P2 §2.2 の「新人スタッフ」判定）。
 *
 * `acceptedAt`（招待を受けた時刻）が真の運用開始。未設定なら行の作成時刻で
 * 代用する。**「30 日未満か」の判定そのものはここで行わない。**
 * 現在時刻との比較は `packages/engine` の純粋関数側に置く（この層に
 * `Date.now()` を持ち込まない）。
 *
 * ── 個人の指標として使わないこと ────────────────────────
 * 戻り値は「検査対象に選ぶか」の入力にだけ使う。在籍日数を画面に出す・
 * 評価に使うのは security.md §5 の禁止事項にあたる。
 */
export async function findMembershipStartedAt(
  env: Env,
  ctx: TenantContext,
  membershipId: string,
): Promise<Date | undefined> {
  assertIdBelongsToTenant(membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select({ acceptedAt: membership.acceptedAt, createdAt: membership.createdAt })
    .from(membership)
    .where(
      withTenantScope(membership, ctx, NO_PROPERTY_SCOPE, eq(membership.id, membershipId)),
    )
    .limit(1);
  if (row === undefined) return undefined;
  return row.acceptedAt ?? row.createdAt;
}

/**
 * ロールごとの在籍者数（P5-15 / PK-SPEC-P5 §7.2 の「稼働スタッフ 34名」）。
 *
 * ── 数えるだけで、誰かは返さない ────────────────────────
 * `listUsers()` を呼んで画面で数えると、**画面が全員の氏名とスタッフ番号を
 * 手にする**ことになる。表示するのは人数だけなので、人数だけを返す口を
 * 置く（security.md §5「個人ランキング・自動評価を実装しない」の手前で、
 * そもそも個人が並ぶ配列を渡さない）。
 *
 * ── 「その月に働いた人数」ではない ──────────────────────
 * 有効な `membership` の数。稼働実績から数えるには、どのタスクを誰が
 * やったかを月ぶん集計することになり、**個人単位の指標そのもの**になる
 * （security.md §5 / docs/DECISIONS.md #135）。在籍で代える。
 *
 * 組織内の GROUP BY なので、テナント横断の集計にはあたらない
 * （architecture.md §3 が禁じるのは組織をまたぐ集計）。
 *
 * @returns ロール → 人数。**0 人のロールは載らない。**
 */
export async function countActiveMembershipsByRole(
  env: Env,
  ctx: TenantContext,
): Promise<Map<Role, number>> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ role: membership.role, count: count() })
    .from(membership)
    .where(withTenantScope(membership, ctx, NO_PROPERTY_SCOPE, eq(membership.isActive, true)))
    .groupBy(membership.role);
  return new Map(rows.map((row) => [row.role, row.count]));
}

/**
 * 現場スタッフの登録（P7-01 / PK-SPEC-P7 §2.3 Step 5）の入力。
 *
 * **PIN の平文を受け取らない。** ハッシュだけを受ける。
 * PBKDF2 は WebCrypto の非同期 API で、`packages/db` は Workers の
 * 暗号を呼ばない層にしてある（`setPasswordHash()` と同じ扱い）。
 * 発行とハッシュ化は `apps/web/src/lib/auth/pin.ts` の責務。
 */
export interface CreateFieldStaffInput {
  displayName: string;
  /** 組織内で一意（`uq_user_org_staff_number`）。 */
  staffNumber: string;
  /** **PIN でログインするロールだけ。** 型で 2 つに絞っている。 */
  role: Extract<Role, "CLEANER" | "INSPECTOR">;
  /** 通知の送信先。持たなくてよい（DECISIONS #018）。 */
  email: string | null;
  /** `pbkdf2$sha256$5000$...` 形式（DECISIONS #021）。 */
  pinHash: string;
  locale?: string | undefined;
  /** 担当施設。**空で呼ばないこと**（割当が無いとタスクが 1 件も出ない）。 */
  propertyIds: readonly string[];
  /** 招待した操作者の membership ID。監査で辿れるようにする（security.md §6）。 */
  invitedBy: string;
}

export interface CreateFieldStaffResult {
  /** スタッフ番号が既に使われていれば `false`。行は 1 つも作らない。 */
  created: boolean;
  userId: string;
  membershipId: string;
}

/**
 * 現場スタッフを 1 名登録する。**`user` / `membership` / `property_assignment`
 * の 3 表を作る。**
 *
 * ── なぜ 3 表を 1 関数にまとめるのか ────────────────────
 * 3 つが揃って初めて「ログインできて、タスクが見える」状態になる。
 * 別々の関数にすると、`user` だけ作られて `membership` が無い行が
 * 生まれうる。**その行はログインできるのにロールが引けない**ため、
 * 認証の組み立て（`findMembershipByUserId`）が空を返し、原因が
 * 画面から読めない状態になる。
 *
 * D1 に跨るトランザクションは無いので**完全な原子性は無い。**
 * 途中で落ちた場合に残るのは「`user` だけ」または「`user` +
 * `membership`」で、**どちらも同じスタッフ番号での再実行が
 * `created: false` になる。** そのときは行を無効化してから作り直す。
 *
 * ── 重複は例外にしない ──────────────────────────────────
 * `created: false` を返して呼び出し側に決めさせる（`createRoomType()`
 * と同じ形）。スタッフ番号の重複は運用でごく普通に起きる。
 *
 * 監査ログ（`recordAudit`）はこの層では呼ばない。呼ぶのは API ハンドラ側。
 */
export async function createFieldStaff(
  env: Env,
  ctx: TenantContext,
  input: CreateFieldStaffInput,
): Promise<CreateFieldStaffResult> {
  for (const propertyId of input.propertyIds) assertIdBelongsToTenant(propertyId, ctx);
  assertIdBelongsToTenant(input.invitedBy, ctx);

  const db = await getTenantDb(env, ctx);
  const userId = generateId(ctx.orgShortId, "usr");
  const membershipId = generateId(ctx.orgShortId, "mem");

  const inserted = await db
    .insert(user)
    .values({
      id: userId,
      organizationId: ctx.organizationId,
      email: input.email,
      staffNumber: input.staffNumber,
      pinHash: input.pinHash,
      // security.md §2「初回変更を強制する」。既定値と同じだが、
      // **既定に頼らず明示する。** ここが false で作られると、
      // 発行した PIN がそのまま使われ続ける。
      pinMustChange: true,
      displayName: input.displayName,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing();

  if (inserted.meta.changes === 0) return { created: false, userId, membershipId };

  await db.insert(membership).values({
    id: membershipId,
    organizationId: ctx.organizationId,
    userId,
    role: input.role,
    invitedBy: input.invitedBy,
    invitedAt: ctx.now,
    // **`acceptedAt` を入れない。** 本人が初めてログインするまでは
    // 「招待済み・未受諾」。`findMembershipStartedAt()` がこの差を見る。
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });

  for (const propertyId of input.propertyIds) {
    await db
      .insert(propertyAssignment)
      .values({
        id: generateId(ctx.orgShortId, "asgn"),
        organizationId: ctx.organizationId,
        membershipId,
        propertyId,
        assignedBy: input.invitedBy,
        assignedAt: ctx.now,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoNothing();
  }

  return { created: true, userId, membershipId };
}

// ────────────────────────────────────────────────────────────
// メンバー管理（W-12 権限と監査の権限側 / 人間の指示 2026-08-19）
//
// メール招待は作らない（DECISIONS #203。ログイン識別子にメールを
// 使わない #018 と、招待トークンの寿命が未定義な OPEN_QUESTIONS #101 を
// 同時に避ける）。初期パスワードはサーバーが発行し 1 回だけ返す
// （P7-02 の PIN と同じ扱い / #177）。
// ────────────────────────────────────────────────────────────

/** パスワードでログインする管理系ロール（security.md §2 の「管理系」）。 */
export const ADMIN_STAFF_ROLES = [
  "OWNER",
  "ORG_ADMIN",
  "PROPERTY_MANAGER",
  "VENDOR_ADMIN",
  "AUDITOR",
  "CLIENT_VIEWER",
] as const;

export type AdminStaffRole = (typeof ADMIN_STAFF_ROLES)[number];

export interface CreateAdminStaffInput {
  displayName: string;
  /** 組織内で一意（`uq_user_org_staff_number`）。 */
  staffNumber: string;
  role: AdminStaffRole;
  /** 通知の送信先。持たなくてよい（DECISIONS #018）。 */
  email: string | null;
  /** `pbkdf2$sha256$210000$...` 形式（security.md §2）。 */
  passwordHash: string;
  locale?: string | undefined;
  /**
   * 担当施設。**施設スコープのロール（PROPERTY_MANAGER / VENDOR_ADMIN）は
   * 空で呼ばないこと**（担当が無いと何も見えないアカウントになる）。
   * 組織全体のロールは空でよい。
   */
  propertyIds: readonly string[];
  /**
   * 発注元ロール（CLIENT_VIEWER）の属する取引先（P5-16）。
   * **CLIENT_VIEWER は必ず指定し、他ロールでは渡さないこと。**
   * 未設定の CLIENT_VIEWER は請求が 1 件も見えない（`scopeToCounterparty()`）。
   */
  counterpartyId?: string | null | undefined;
  invitedBy: string;
}

/**
 * 管理系ユーザーを 1 名登録する。`createFieldStaff()` のパスワード版。
 *
 * 3 表（user / membership / property_assignment）の関係・原子性の注記は
 * `createFieldStaff()` と同じ。**PIN 列には触れない**（現場系へロールを
 * 変えるときは資格情報の再発行が別に要る）。
 */
export async function createAdminStaff(
  env: Env,
  ctx: TenantContext,
  input: CreateAdminStaffInput,
): Promise<CreateFieldStaffResult> {
  for (const propertyId of input.propertyIds) assertIdBelongsToTenant(propertyId, ctx);
  assertIdBelongsToTenant(input.invitedBy, ctx);
  if (input.counterpartyId != null) assertIdBelongsToTenant(input.counterpartyId, ctx);

  const db = await getTenantDb(env, ctx);
  const userId = generateId(ctx.orgShortId, "usr");
  const membershipId = generateId(ctx.orgShortId, "mem");

  const inserted = await db
    .insert(user)
    .values({
      id: userId,
      organizationId: ctx.organizationId,
      email: input.email,
      staffNumber: input.staffNumber,
      passwordHash: input.passwordHash,
      passwordUpdatedAt: ctx.now,
      displayName: input.displayName,
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing();

  if (inserted.meta.changes === 0) return { created: false, userId, membershipId };

  await db.insert(membership).values({
    id: membershipId,
    organizationId: ctx.organizationId,
    userId,
    role: input.role,
    counterpartyId: input.counterpartyId ?? null,
    invitedBy: input.invitedBy,
    invitedAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });

  for (const propertyId of input.propertyIds) {
    await db
      .insert(propertyAssignment)
      .values({
        id: generateId(ctx.orgShortId, "asgn"),
        organizationId: ctx.organizationId,
        membershipId,
        propertyId,
        assignedBy: input.invitedBy,
        assignedAt: ctx.now,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoNothing();
  }

  return { created: true, userId, membershipId };
}

/** メンバー一覧の 1 行（W-12）。**ハッシュは載せない。** */
export interface OrgMember {
  userId: string;
  membershipId: string;
  staffNumber: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  /** 資格情報の種別。再発行の出し分けに使う。 */
  hasPassword: boolean;
  hasPin: boolean;
}

/**
 * 組織の全メンバー（user × membership）。
 *
 * **テナント内の JOIN**（同一組織・同一シャード）。architecture.md §3 が
 * 禁じるのはテナント横断で、これは違う。無効化済みも返す —
 * 再有効化の入口がこの一覧しか無い。
 */
export async function listOrgMembers(env: Env, ctx: TenantContext): Promise<OrgMember[]> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({
      userId: user.id,
      membershipId: membership.id,
      staffNumber: user.staffNumber,
      displayName: user.displayName,
      role: membership.role,
      isActive: user.isActive,
      passwordHash: user.passwordHash,
      pinHash: user.pinHash,
    })
    .from(membership)
    .innerJoin(user, eq(membership.userId, user.id))
    .where(
      withTenantScope(
        membership,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(user.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(user.staffNumber);

  return rows.map((row) => ({
    userId: row.userId,
    membershipId: row.membershipId,
    // 旧データにスタッフ番号の無い行がありうる（列は null 許容）。表示用に空へ寄せる。
    staffNumber: row.staffNumber ?? "",
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    hasPassword: row.passwordHash !== null,
    hasPin: row.pinHash !== null,
  }));
}

/**
 * ロールの変更。**呼び出し側が必ず `recordAudit()`（`user.roleChanged`）。**
 *
 * 自分自身の変更・最後の OWNER の降格を拒むのは呼び出し側
 * （`lib/staff/manage.ts`）。ここは書き換えるだけ。
 */
export async function updateMembershipRole(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; role: Role },
): Promise<number> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(membership)
    .set({ role: input.role, updatedAt: ctx.now })
    .where(
      withTenantScope(
        membership,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(membership.id, input.membershipId),
      ),
    );
  return result.meta.changes;
}

/**
 * アカウントの有効・無効。**物理削除の口は無い**（PK-SPEC-P0 §26）。
 * 呼び出し側が必ず `recordAudit()`（`user.deactivated` / `user.reactivated`）。
 */
export async function setUserActive(
  env: Env,
  ctx: TenantContext,
  input: { userId: string; isActive: boolean },
): Promise<number> {
  assertIdBelongsToTenant(input.userId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(user)
    .set({ isActive: input.isActive, updatedAt: ctx.now })
    .where(withTenantScope(user, ctx, NO_PROPERTY_SCOPE, eq(user.id, input.userId)));
  return result.meta.changes;
}

/**
 * PIN の再発行（security.md §2「PIN リセットは管理者のみ。必ず監査ログ」）。
 * 初回変更を強制し直す。失敗回数のロックも解く（リセットの目的が
 * 「入れなくなった人を入れるようにする」ため）。
 */
export async function resetUserPin(
  env: Env,
  ctx: TenantContext,
  input: { userId: string; pinHash: string },
): Promise<number> {
  assertIdBelongsToTenant(input.userId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(user)
    .set({
      pinHash: input.pinHash,
      pinMustChange: true,
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: ctx.now,
    })
    .where(withTenantScope(user, ctx, NO_PROPERTY_SCOPE, eq(user.id, input.userId)));
  return result.meta.changes;
}

/**
 * パスワードの再発行。PIN と同じ扱い（発行値は 1 回だけ返り、保存されない）。
 */
export async function resetUserPassword(
  env: Env,
  ctx: TenantContext,
  input: { userId: string; passwordHash: string },
): Promise<number> {
  assertIdBelongsToTenant(input.userId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(user)
    .set({
      passwordHash: input.passwordHash,
      passwordUpdatedAt: ctx.now,
      failedLoginCount: 0,
      lockedUntil: null,
      updatedAt: ctx.now,
    })
    .where(withTenantScope(user, ctx, NO_PROPERTY_SCOPE, eq(user.id, input.userId)));
  return result.meta.changes;
}

/**
 * 有効なメンバーを**表示言語ごとに**数える（PF-05 の「言語の利用割合」）。
 *
 * ── 個人を返さない（security.md §5 / INV-07）────────────
 * 返すのは言語 → 人数だけ。**誰が何語かを引ける口にしない。**
 * 運営面（PF-05）へ渡る値なので、個人単位の軸を作らない。
 *
 * 組織内の GROUP BY なので、テナント横断の集計にはあたらない。
 */
export async function countActiveMembersByLocale(
  env: Env,
  ctx: TenantContext,
): Promise<Map<string, number>> {
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select({ locale: user.locale, count: count() })
    .from(membership)
    .innerJoin(
      user,
      and(eq(user.organizationId, membership.organizationId), eq(user.id, membership.userId)),
    )
    .where(withTenantScope(membership, ctx, NO_PROPERTY_SCOPE, eq(membership.isActive, true)))
    .groupBy(user.locale);
  return new Map(rows.map((row) => [row.locale, row.count]));
}
