/**
 * メンバー管理（W-12 権限と監査の権限側）。
 *
 * 経緯:  人間の指示 2026-08-19「P7-02 と同じ初期パスワード発行方式で」。
 * 参照:  ui-prototypes/owner/pkown-v3-D-billing-settings-perm.html（12）
 * ルール: .claude/rules/security.md §1・§2・§6 / DECISIONS #203
 *
 * ── メール招待を作らない ────────────────────────────────
 * ログイン識別子にメールを使わない（DECISIONS #018）ため、招待リンクを
 * 送る意味が無い。初期パスワードはサーバーが発行し、案内カードとして
 * **1 回だけ**表示する（P7-02 の PIN / #177 と同じ）。OPEN_QUESTIONS #101
 * （招待トークンの寿命）はこの判断で問い自体が消える。
 *
 * ── 安全装置（この層で必ず掛ける）───────────────────────
 * - 自分自身のロール変更・無効化はできない（うっかり自分を締め出さない）。
 * - **最後の有効な OWNER** を降格・無効化できない（組織に入れる人が
 *   いなくなる。復旧の口が DB 直接操作しか無くなる）。
 * - ロール変更は**資格情報の族の中だけ**（管理系 ⇄ 管理系、現場系 ⇄ 現場系）。
 *   族をまたぐと持っている資格情報でログインできないロールになる。
 *   またぎたい場合は新しい番号で登録し直す。
 *
 * ── 監査 ────────────────────────────────────────────────
 * すべての操作が `recordAudit()` を通る（security.md §6）。
 * before / after にハッシュ・発行値を載せない。
 */

import { FIELD_STAFF_ROLES } from "@pk/contracts";
import {
  ADMIN_STAFF_ROLES,
  createAdminStaff,
  listOrgMembers,
  recordAudit,
  resetUserPassword,
  resetUserPin,
  setUserActive,
  updateMembershipRole,
  type AdminStaffRole,
  type Env,
  type OrgMember,
  type Role,
  type TenantContext,
} from "@pk/db";

import { ORGANIZATION_TARGET, assertPermission, propertyTarget } from "../auth/permission.js";
import { generateInitialPassword, hashPassword } from "../auth/password.js";
import { generateInitialPin, hashPin } from "../auth/pin.js";

/** 操作の結果。**拒んだ理由を画面がそのまま出せる形で返す。** */
export type ManageOutcome =
  | { kind: "DONE" }
  | { kind: "SELF" }
  | { kind: "LAST_OWNER" }
  | { kind: "ROLE_FAMILY" }
  | { kind: "NOT_FOUND" };

export type RegisterAdminOutcome =
  | { kind: "CREATED"; staffNumber: string; displayName: string; password: string }
  | { kind: "DUPLICATE" };

export type ReissueOutcome =
  | { kind: "REISSUED"; credential: "PASSWORD" | "PIN"; value: string }
  | { kind: "NOT_FOUND" };

function isAdminRole(role: Role): role is AdminStaffRole {
  return (ADMIN_STAFF_ROLES as readonly string[]).includes(role);
}

function isFieldRole(role: Role): boolean {
  return (FIELD_STAFF_ROLES as readonly string[]).includes(role);
}

/** 施設スコープの管理系ロール。**割当が無いと何も見えない。** */
const ASSIGNED_ADMIN_ROLES: readonly AdminStaffRole[] = ["PROPERTY_MANAGER", "VENDOR_ADMIN"];

export interface RegisterAdminInput {
  displayName: string;
  staffNumber: string;
  role: AdminStaffRole;
  email: string | null;
  propertyIds: readonly string[];
}

/**
 * 管理系ユーザーを登録し、**初期パスワードを 1 回だけ返す。**
 *
 * 施設スコープのロールは施設割当が必須（空なら呼び出し側で弾いておく）。
 */
export async function registerAdminStaff(
  env: Env,
  ctx: TenantContext,
  input: RegisterAdminInput,
  actorId: string,
): Promise<RegisterAdminOutcome> {
  // 管理系の登録は組織全体の権限で見る（施設責任者に組織の管理者を
  // 作らせない）。現場スタッフの登録（P7-02）とは門が違う。
  assertPermission(ctx, "user.write", ORGANIZATION_TARGET);
  if (ASSIGNED_ADMIN_ROLES.includes(input.role) && input.propertyIds.length > 0) {
    assertPermission(ctx, "user.write", propertyTarget(input.propertyIds));
  }

  const password = generateInitialPassword();
  const result = await createAdminStaff(env, ctx, {
    displayName: input.displayName,
    staffNumber: input.staffNumber,
    role: input.role,
    email: input.email,
    passwordHash: await hashPassword(password),
    propertyIds: input.propertyIds,
    invitedBy: actorId,
  });
  if (!result.created) return { kind: "DUPLICATE" };

  await recordAudit(env, ctx, {
    actorId,
    action: "user.invited",
    targetType: "user",
    targetId: result.userId,
    // **after にパスワードもハッシュも載せない**（security.md §6）。
    after: {
      staffNumber: input.staffNumber,
      displayName: input.displayName,
      role: input.role,
      propertyIds: input.propertyIds,
    },
  });

  return {
    kind: "CREATED",
    staffNumber: input.staffNumber,
    displayName: input.displayName,
    password,
  };
}

/** 対象を引く。一覧ごと返す（最後の OWNER 判定に同じ一覧を使う）。 */
async function findMember(
  env: Env,
  ctx: TenantContext,
  membershipId: string,
): Promise<{ member: OrgMember | undefined; members: OrgMember[] }> {
  const members = await listOrgMembers(env, ctx);
  return { member: members.find((entry) => entry.membershipId === membershipId), members };
}

/**
 * 最後の有効な OWNER か（降格・無効化を拒む条件）。
 * **`user.isActive` で数える**（無効化はユーザー側の旗で行うため）。
 */
function isLastActiveOwner(members: readonly OrgMember[], member: OrgMember): boolean {
  if (member.role !== "OWNER" || !member.isActive) return false;
  return members.filter((entry) => entry.role === "OWNER" && entry.isActive).length <= 1;
}

export async function changeMemberRole(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; role: Role; actorId: string },
): Promise<ManageOutcome> {
  assertPermission(ctx, "user.write", ORGANIZATION_TARGET);
  if (input.membershipId === input.actorId) return { kind: "SELF" };

  const { member, members } = await findMember(env, ctx, input.membershipId);
  if (member === undefined) return { kind: "NOT_FOUND" };
  if (member.role === input.role) return { kind: "DONE" };

  // 資格情報の族をまたがない（冒頭の注記）。
  const sameFamily =
    (isAdminRole(member.role) && isAdminRole(input.role)) ||
    (isFieldRole(member.role) && isFieldRole(input.role));
  if (!sameFamily) return { kind: "ROLE_FAMILY" };

  if (isLastActiveOwner(members, member)) return { kind: "LAST_OWNER" };

  const changed = await updateMembershipRole(env, ctx, {
    membershipId: input.membershipId,
    role: input.role,
  });
  if (changed === 0) return { kind: "NOT_FOUND" };

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "user.roleChanged",
    targetType: "membership",
    targetId: input.membershipId,
    before: { role: member.role },
    after: { role: input.role },
  });
  return { kind: "DONE" };
}

export async function setMemberActive(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; isActive: boolean; actorId: string },
): Promise<ManageOutcome> {
  assertPermission(ctx, "user.write", ORGANIZATION_TARGET);
  if (input.membershipId === input.actorId) return { kind: "SELF" };

  const { member, members } = await findMember(env, ctx, input.membershipId);
  if (member === undefined) return { kind: "NOT_FOUND" };
  if (member.isActive === input.isActive) return { kind: "DONE" };
  if (!input.isActive && isLastActiveOwner(members, member)) return { kind: "LAST_OWNER" };

  const changed = await setUserActive(env, ctx, {
    userId: member.userId,
    isActive: input.isActive,
  });
  if (changed === 0) return { kind: "NOT_FOUND" };

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: input.isActive ? "user.reactivated" : "user.deactivated",
    targetType: "user",
    targetId: member.userId,
    before: { isActive: member.isActive },
    after: { isActive: input.isActive },
  });
  return { kind: "DONE" };
}

/**
 * 資格情報の再発行。**ロールの族で PIN かパスワードかが決まる。**
 * 発行値は 1 回だけ返る。ロックも解ける（`resetUserPin()` の注記）。
 */
export async function reissueCredential(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; actorId: string },
): Promise<ReissueOutcome> {
  assertPermission(ctx, "user.write", ORGANIZATION_TARGET);

  const { member } = await findMember(env, ctx, input.membershipId);
  if (member === undefined) return { kind: "NOT_FOUND" };

  if (isFieldRole(member.role)) {
    const pin = generateInitialPin();
    const changed = await resetUserPin(env, ctx, {
      userId: member.userId,
      pinHash: await hashPin(pin),
    });
    if (changed === 0) return { kind: "NOT_FOUND" };
    await recordAudit(env, ctx, {
      actorId: input.actorId,
      action: "user.pinReset",
      targetType: "user",
      targetId: member.userId,
    });
    return { kind: "REISSUED", credential: "PIN", value: pin };
  }

  const password = generateInitialPassword();
  const changed = await resetUserPassword(env, ctx, {
    userId: member.userId,
    passwordHash: await hashPassword(password),
  });
  if (changed === 0) return { kind: "NOT_FOUND" };
  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "user.passwordReset",
    targetType: "user",
    targetId: member.userId,
  });
  return { kind: "REISSUED", credential: "PASSWORD", value: password };
}
