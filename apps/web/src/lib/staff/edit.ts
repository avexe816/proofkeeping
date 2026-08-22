/**
 * スタッフ詳細レイヤーの読み書き（W-07 / 人間の指示 2026-08-22）。
 *
 * 一覧の「詳細」から右側にスライドインするレイヤーで、登録内容を直し、
 * 退職した方を無効化する。**新規登録も同じレイヤーで行う**（画面の
 * 最下部に長いフォームを置かない / `staff.tsx` の注記）。
 *
 * ルール: .claude/rules/security.md §1（権限）・§5（従業員データ）・§6（監査ログ）
 *
 * ── なぜ画面から切り出してあるのか ──────────────────────
 * `routes/app/staff.tsx` は**初期 PIN を `action` の戻り値として運ぶ**
 * （DECISIONS #177 / #184）。`tests/security/initialPin.spec.ts` は
 * PIN を持つファイルから監査ログ・Queue・ログ・R2 への口が生えていない
 * ことを見ている。**口はこちらへ寄せる**（`residency.ts` と同じ理由）。
 *
 * ── 「削除」は無効化 ────────────────────────────────────
 * 物理削除の口は無い（PK-SPEC-P0 §26 / `setUserActive()` の注記）。
 * 過去のタスク・検査・証跡がこのユーザーを参照しているため、行を消すと
 * 記録の側が誰の作業だったかを失う。**無効化すればログインは止まり、
 * 割当の候補からも外れる**（`listOrgStaff()` の 2 つの旗）。
 * 戻せる操作にしてあるのは意図で、片道の破壊を作らない。
 *
 * ── この画面が触れるのは現場スタッフだけ ────────────────
 * 対象は `FIELD_STAFF_ROLES`（`CLEANER` / `INSPECTOR`）に限る。
 * 管理系ユーザー（`OWNER` ほか）は W-12（権限と監査）が持つ。
 * **ここを広げないこと。** 広げると「最後の `OWNER` を無効化できない」
 * という安全装置（`manage.ts` の `isLastActiveOwner()`）を素通りする
 * 経路が 2 本目にできる。
 */

import { FIELD_STAFF_ROLES, fieldStaffUpdateSchema } from "@pk/contracts";
import {
  findOrgStaffDetail,
  listStaffPropertyAssignments,
  recordAudit,
  replacePropertyAssignments,
  setUserActive,
  updateMembershipRole,
  updateUserProfile,
  type Env,
  type Role,
  type TenantContext,
} from "@pk/db";

import { assertPermission, propertyTarget } from "../auth/permission.js";

/** レイヤーが出す 1 名ぶん。**フォームの初期値になる値だけ。** */
export interface StaffDetail {
  membershipId: string;
  displayName: string;
  staffNumber: string | null;
  role: Role;
  locale: string;
  email: string | null;
  isActive: boolean;
  /** 現在の担当施設。チェックボックスの初期値。 */
  propertyIds: readonly string[];
  /**
   * この画面から編集できる相手か（上の注記）。
   * 偽なら、レイヤーは詳細を出すだけで、フォームもボタンも出さない。
   */
  isFieldStaff: boolean;
}

/** 書き込みの結果。**拒んだ理由を画面がそのまま出せる形で返す。** */
export type StaffEditResult =
  | { staffSaved: "UPDATED" | "DEACTIVATED" | "REACTIVATED" }
  /** 入力の形式が違う（Zod）。 */
  | { staffInvalid: true }
  /** 対象が見つからない。**別組織の ID もここへ落ちる**（404 と同じ扱い）。 */
  | { staffNotFound: true }
  /** 現場スタッフ以外を触ろうとした（W-12 の担当）。 */
  | { staffNotField: true }
  /** 自分自身を無効化しようとした（締め出しを防ぐ）。 */
  | { staffSelf: true };

function isFieldRole(role: Role): boolean {
  return (FIELD_STAFF_ROLES as readonly string[]).includes(role);
}

function fieldOf(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * 書き込みが使う 1 名ぶん。**`userId` を持つ。**
 *
 * `StaffDetail`（画面へ渡る形）に `userId` を入れていないのは、
 * loader の戻り値が HTML に載るため。**外に出す必要が無い ID を
 * 出さない**（architecture.md §2 のシャード番号と同じ考え方）。
 */
interface StaffRecord extends StaffDetail {
  userId: string;
}

/**
 * 1 名ぶんを引く。
 *
 * **一覧に `email` を混ぜない。** 一覧の戻り値は画面の JSON にそのまま
 * 載るので、足すと組織全員の連絡先が HTML に出る。開いている 1 名の
 * ぶんだけをここで引く（`findOrgStaffDetail()` の注記）。
 *
 * 見つからないときは `undefined`。**別組織の ID は
 * `assertIdBelongsToTenant()` が先に落とす**（404 / architecture.md §2）。
 */
async function loadStaffRecord(
  env: Env,
  tenant: TenantContext,
  membershipId: string,
): Promise<StaffRecord | undefined> {
  const [detail, assignments] = await Promise.all([
    findOrgStaffDetail(env, tenant, membershipId),
    listStaffPropertyAssignments(env, tenant),
  ]);
  if (detail === undefined) return undefined;

  return {
    membershipId: detail.membershipId,
    userId: detail.userId,
    displayName: detail.displayName,
    staffNumber: detail.staffNumber,
    role: detail.role,
    locale: detail.locale,
    email: detail.email,
    isActive: detail.isActive,
    propertyIds: assignments
      .filter((assignment) => assignment.membershipId === membershipId)
      .map((assignment) => assignment.propertyId),
    isFieldStaff: isFieldRole(detail.role),
  };
}

/** レイヤーへ渡す 1 名ぶん。**`userId` を落として返す。** */
export async function loadStaffDetail(
  env: Env,
  tenant: TenantContext,
  membershipId: string,
): Promise<StaffDetail | undefined> {
  const record = await loadStaffRecord(env, tenant, membershipId);
  if (record === undefined) return undefined;

  // **列を挙げて詰め直す。** スプレッドで `userId` を除く形にすると、
  // `StaffRecord` に列が増えたときに黙って画面へ流れる。
  return {
    membershipId: record.membershipId,
    displayName: record.displayName,
    staffNumber: record.staffNumber,
    role: record.role,
    locale: record.locale,
    email: record.email,
    isActive: record.isActive,
    propertyIds: record.propertyIds,
    isFieldStaff: record.isFieldStaff,
  };
}

/**
 * 登録内容を更新する。
 *
 * ── 門を 2 度通す ───────────────────────────────────────
 * **今の担当施設と、これから割り当てる施設の両方**を対象に見る。
 * 片方だけだと、`PROPERTY_MANAGER` が
 *
 *   ① 担当外の施設のスタッフを自分の施設へ引き取る（今の側を見ない場合）
 *   ② 自分の施設のスタッフを担当外の施設へ送る（新しい側を見ない場合）
 *
 * のどちらかができてしまう。**`user.write` は `ASSIGNED`**
 * （`permission.ts` の表）なので、両方の和で見れば両方が閉じる。
 *
 * ── ロールは族の中だけ ──────────────────────────────────
 * 受けるのは `FIELD_STAFF_ROLES` だけ（Zod が閉じている）。現場系 ⇄
 * 管理系のまたぎは `manage.ts` と同じく**許さない** — 持っている資格情報
 * （PIN）でログインできないロールになるため。
 */
export async function updateStaff(
  env: Env,
  tenant: TenantContext,
  actorId: string,
  form: FormData,
): Promise<StaffEditResult> {
  const email = fieldOf(form, "email").trim();
  const parsed = fieldStaffUpdateSchema.safeParse({
    membershipId: fieldOf(form, "membershipId"),
    displayName: fieldOf(form, "displayName"),
    role: fieldOf(form, "role"),
    email: email === "" ? null : email,
    propertyIds: form.getAll("propertyIds").filter((value) => typeof value === "string"),
    locale: fieldOf(form, "locale"),
  });
  if (!parsed.success) return { staffInvalid: true };

  const current = await loadStaffRecord(env, tenant, parsed.data.membershipId);
  if (current === undefined) return { staffNotFound: true };
  if (!current.isFieldStaff) return { staffNotField: true };

  // 上の注記。**今と新しいのを合わせた集合**で見る。
  assertPermission(
    tenant,
    "user.write",
    propertyTarget([...new Set([...current.propertyIds, ...parsed.data.propertyIds])]),
  );

  await updateUserProfile(env, tenant, {
    userId: current.userId,
    displayName: parsed.data.displayName,
    email: parsed.data.email,
    locale: parsed.data.locale,
  });

  if (current.role !== parsed.data.role) {
    await updateMembershipRole(env, tenant, {
      membershipId: parsed.data.membershipId,
      role: parsed.data.role,
    });
  }

  await replacePropertyAssignments(env, tenant, {
    membershipId: parsed.data.membershipId,
    propertyIds: parsed.data.propertyIds,
    assignedBy: actorId,
  });

  await recordAudit(env, tenant, {
    actorId,
    action: "user.updated",
    targetType: "membership",
    targetId: parsed.data.membershipId,
    // **連絡先を載せない**（`AUDIT_ACTIONS` の注記）。追えればよいのは
    // 「誰がいつ役割と担当施設を動かしたか」。
    before: { role: current.role, propertyIds: [...current.propertyIds] },
    after: { role: parsed.data.role, propertyIds: parsed.data.propertyIds },
  });

  return { staffSaved: "UPDATED" };
}

/**
 * 無効化・再有効化（画面の「利用を停止する」「利用を再開する」）。
 *
 * ── 自分自身は停められない ──────────────────────────────
 * `manage.ts` の `setMemberActive()` と同じ安全装置。うっかり自分を
 * 締め出すと、復旧の口が別の管理者を探すことしか無くなる。
 *
 * ── 最後の `OWNER` の判定を持たない ─────────────────────
 * 要らない。**この関数は現場スタッフしか受けない**（`OWNER` は
 * `isFieldRole()` で先に落ちる）。持つと同じ判定が 2 か所になる。
 */
export async function setStaffActive(
  env: Env,
  tenant: TenantContext,
  actorId: string,
  input: { membershipId: string; isActive: boolean },
): Promise<StaffEditResult> {
  if (input.membershipId === actorId) return { staffSelf: true };

  const current = await loadStaffRecord(env, tenant, input.membershipId);
  if (current === undefined) return { staffNotFound: true };
  if (!current.isFieldStaff) return { staffNotField: true };

  assertPermission(tenant, "user.write", propertyTarget(current.propertyIds));

  await setUserActive(env, tenant, { userId: current.userId, isActive: input.isActive });

  await recordAudit(env, tenant, {
    actorId,
    action: input.isActive ? "user.reactivated" : "user.deactivated",
    targetType: "user",
    targetId: current.userId,
    before: { isActive: current.isActive },
    after: { isActive: input.isActive },
  });

  return { staffSaved: input.isActive ? "REACTIVATED" : "DEACTIVATED" };
}
