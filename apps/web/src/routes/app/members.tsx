/**
 * W-12 権限と監査（権限側）— メンバー管理。
 *
 *   /app/settings/members
 *
 * 経緯:  人間の指示 2026-08-19（P7-02 と同じ初期パスワード発行方式）。
 * 参照:  ui-prototypes/owner/pkown-v3-D-billing-settings-perm.html（12）
 * ルール: .claude/rules/security.md §1・§2・§6 / DECISIONS #203
 *
 * ── できること ──────────────────────────────────────────
 * 管理系ユーザーの登録（初期パスワードを 1 回だけ表示）・ロール変更・
 * 無効化と再有効化・資格情報（PIN / パスワード）の再発行。
 * 現場スタッフ（清掃・検査）の**登録**は従来どおりスタッフ管理（P7-02）。
 * 監査ログの**閲覧**はサイドバーの「監査ログ」（P7-20）。
 *
 * ── 発行値は action の戻り値だけ ────────────────────────
 * `loader` へ渡さない（GET は URL にも履歴にも残る / P7-02 と同じ）。
 * 画面を離れたら二度と出ない。
 */

import { NotFoundError, ROLES, listOrgMembers, type Role } from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { listSelectableProperties } from "../../lib/property/selection.js";
import {
  changeMemberRole,
  registerAdminStaff,
  reissueCredential,
  setMemberActive,
  type ManageOutcome,
} from "../../lib/staff/manage.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** この画面から登録できるロール（管理系）。現場系は P7-02 の画面で。 */
const ADMIN_ROLE_OPTIONS = [
  "ORG_ADMIN",
  "PROPERTY_MANAGER",
  "VENDOR_ADMIN",
  "AUDITOR",
  "OWNER",
] as const;

/** 施設割当が必須のロール。 */
const ASSIGNED_ROLES: readonly string[] = ["PROPERTY_MANAGER", "VENDOR_ADMIN"];

const ROLE_LABEL: Record<Role, MessageKey> = {
  OWNER: "role.OWNER",
  ORG_ADMIN: "role.ORG_ADMIN",
  PROPERTY_MANAGER: "role.PROPERTY_MANAGER",
  INSPECTOR: "role.INSPECTOR",
  CLEANER: "role.CLEANER",
  VENDOR_ADMIN: "role.VENDOR_ADMIN",
  AUDITOR: "role.AUDITOR",
};

interface MemberRow {
  membershipId: string;
  staffNumber: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  hasPin: boolean;
}

interface MembersData {
  members: MemberRow[];
  properties: { id: string; name: string }[];
  /** 自分の membership。自分の行の操作を出さない（action 側でも拒む）。 */
  selfMembershipId: string;
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<MembersData> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  // **これが門。** `user.write` を組織全体で持つ相手だけ（OWNER / ORG_ADMIN）。
  // それ以外は 404（項目もサイドバーから消える / security.md §1）。
  assertPermission(tenant, "user.write", ORGANIZATION_TARGET);

  const [members, properties] = await Promise.all([
    listOrgMembers(env, tenant),
    listSelectableProperties(env, tenant),
  ]);

  return {
    members: members.map((member) => ({
      membershipId: member.membershipId,
      staffNumber: member.staffNumber,
      displayName: member.displayName,
      role: member.role,
      isActive: member.isActive,
      hasPin: member.hasPin,
    })),
    properties: properties.map((property) => ({ id: property.id, name: property.name })),
    selfMembershipId: session.membershipId,
  };
}

type MembersFailure =
  | "INVALID"
  | "DUPLICATE"
  | "NEED_PROPERTY"
  | "SELF"
  | "LAST_OWNER"
  | "ROLE_FAMILY";

interface MembersActionResult {
  /** 発行した資格情報。**この応答でしか出ない。** */
  issued?: {
    staffNumber: string;
    displayName: string;
    credential: "PASSWORD" | "PIN";
    value: string;
  };
  done?: boolean;
  failure?: MembersFailure;
}

function failureOf(outcome: ManageOutcome): MembersActionResult {
  if (outcome.kind === "DONE") return { done: true };
  if (outcome.kind === "SELF") return { failure: "SELF" };
  if (outcome.kind === "LAST_OWNER") return { failure: "LAST_OWNER" };
  if (outcome.kind === "ROLE_FAMILY") return { failure: "ROLE_FAMILY" };
  throw new NotFoundError();
}

function textOf(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > maxLength ? null : trimmed;
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<MembersActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);

  assertPermission(tenant, "user.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "create") {
    const displayName = textOf(form.get("displayName"), 64);
    const staffNumber = textOf(form.get("staffNumber"), 16);
    const email = textOf(form.get("email"), 128);
    const roleRaw = form.get("role");
    const role = ADMIN_ROLE_OPTIONS.find((option) => option === roleRaw);
    const propertyIds = form.getAll("propertyIds").filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
    if (displayName === null || staffNumber === null || role === undefined) {
      return { failure: "INVALID" };
    }
    // 施設スコープのロールは割当が無いと何も見えない。登録時に必須にする。
    if (ASSIGNED_ROLES.includes(role) && propertyIds.length === 0) {
      return { failure: "NEED_PROPERTY" };
    }

    const outcome = await registerAdminStaff(
      env,
      tenant,
      { displayName, staffNumber, role, email, propertyIds },
      session.membershipId,
    );
    if (outcome.kind === "DUPLICATE") return { failure: "DUPLICATE" };
    return {
      issued: {
        staffNumber: outcome.staffNumber,
        displayName: outcome.displayName,
        credential: "PASSWORD",
        value: outcome.password,
      },
    };
  }

  const membershipId = form.get("membershipId");
  if (typeof membershipId !== "string") return { failure: "INVALID" };

  if (intent === "role") {
    const roleRaw = form.get("role");
    const role = (ROLES as readonly string[]).includes(roleRaw as string)
      ? (roleRaw as Role)
      : null;
    if (role === null) return { failure: "INVALID" };
    return failureOf(
      await changeMemberRole(env, tenant, {
        membershipId,
        role,
        actorId: session.membershipId,
      }),
    );
  }

  if (intent === "deactivate" || intent === "reactivate") {
    return failureOf(
      await setMemberActive(env, tenant, {
        membershipId,
        isActive: intent === "reactivate",
        actorId: session.membershipId,
      }),
    );
  }

  if (intent === "reissue") {
    const outcome = await reissueCredential(env, tenant, {
      membershipId,
      actorId: session.membershipId,
    });
    if (outcome.kind === "NOT_FOUND") throw new NotFoundError();
    const member = (await listOrgMembers(env, tenant)).find(
      (entry) => entry.membershipId === membershipId,
    );
    return {
      issued: {
        staffNumber: member?.staffNumber ?? "",
        displayName: member?.displayName ?? "",
        credential: outcome.credential,
        value: outcome.value,
      },
    };
  }

  return { failure: "INVALID" };
}

const FAILURE_MESSAGE: Record<MembersFailure, MessageKey> = {
  INVALID: "members.error.invalid",
  DUPLICATE: "members.error.duplicate",
  NEED_PROPERTY: "members.error.needProperty",
  SELF: "members.error.self",
  LAST_OWNER: "members.error.lastOwner",
  ROLE_FAMILY: "members.error.roleFamily",
};

export default function Members() {
  const data = useLoaderData<MembersData>();
  const result = useActionData<MembersActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("members.title")}</h1>
      </div>
      <p className="pk-muted">{t("members.lede")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t(FAILURE_MESSAGE[result.failure])}</p>
      ) : null}
      {result?.done === true ? <p className="pk-notice">{t("members.done")}</p> : null}

      {/* 発行した資格情報。**この画面を離れたら二度と出ない**（P7-02 と同じ）。 */}
      {result?.issued === undefined ? null : (
        <div className="pk-issued">
          <p className="pk-notice">{t("members.issued.once")}</p>
          <dl className="pk-items">
            <dt>{t("members.issued.who")}</dt>
            <dd>{`${result.issued.displayName}（${result.issued.staffNumber}）`}</dd>
            <dt>
              {result.issued.credential === "PASSWORD"
                ? t("members.issued.password")
                : t("members.issued.pin")}
            </dt>
            <dd className="pk-mono">{result.issued.value}</dd>
            <dt>{t("members.issued.loginAt")}</dt>
            <dd>
              {result.issued.credential === "PASSWORD"
                ? t("members.issued.loginAdmin")
                : t("members.issued.loginMobile")}
            </dd>
          </dl>
        </div>
      )}

      {/* ── メンバー一覧 ───────────────────────────────── */}
      <h2 className="pk-section__title">{t("members.list.title")}</h2>
      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("members.column.staffNumber")}</th>
            <th>{t("members.column.name")}</th>
            <th>{t("members.column.role")}</th>
            <th>{t("members.column.state")}</th>
            <th>{t("members.column.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((member) => (
            <tr key={member.membershipId} className={member.isActive ? undefined : "pk-row--muted"}>
              <th scope="row">{member.staffNumber}</th>
              <td>{member.displayName}</td>
              <td>
                {member.membershipId === data.selfMembershipId ? (
                  t(ROLE_LABEL[member.role])
                ) : (
                  <Form method="post" className="pk-inlineform">
                    <input type="hidden" name="intent" value="role" />
                    <input type="hidden" name="membershipId" value={member.membershipId} />
                    <select className="pk-select" name="role" defaultValue={member.role}>
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(ROLE_LABEL[role])}
                        </option>
                      ))}
                    </select>
                    <button className="pk-button" type="submit">
                      {t("members.action.changeRole")}
                    </button>
                  </Form>
                )}
              </td>
              <td>{member.isActive ? t("members.state.active") : t("members.state.inactive")}</td>
              <td>
                {member.membershipId === data.selfMembershipId ? (
                  <span className="pk-muted">{t("members.selfRow")}</span>
                ) : (
                  <Form method="post" className="pk-inlineform">
                    <input type="hidden" name="membershipId" value={member.membershipId} />
                    <button className="pk-button" type="submit" name="intent" value="reissue">
                      {member.hasPin
                        ? t("members.action.reissuePin")
                        : t("members.action.reissuePassword")}
                    </button>
                    <button
                      className="pk-button"
                      type="submit"
                      name="intent"
                      value={member.isActive ? "deactivate" : "reactivate"}
                    >
                      {member.isActive
                        ? t("members.action.deactivate")
                        : t("members.action.reactivate")}
                    </button>
                  </Form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 族をまたぐロール変更はできない（`manage.ts` の安全装置）。 */}
      <p className="pk-muted">{t("members.roleFamilyNote")}</p>

      {/* ── 管理系ユーザーの登録 ───────────────────────── */}
      <h2 className="pk-section__title">{t("members.create.title")}</h2>
      <p className="pk-muted">{t("members.create.lede")}</p>
      <Form method="post" className="pk-filter">
        <input type="hidden" name="intent" value="create" />
        <label className="pk-field">
          <span className="pk-field__label">{t("members.field.displayName")}</span>
          <input className="pk-input" name="displayName" required maxLength={64} />
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("members.field.staffNumber")}</span>
          <input className="pk-input" name="staffNumber" required maxLength={16} />
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("members.field.role")}</span>
          <select className="pk-select" name="role" defaultValue="ORG_ADMIN">
            {ADMIN_ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {t(ROLE_LABEL[role])}
              </option>
            ))}
          </select>
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("members.field.email")}</span>
          <input className="pk-input" name="email" type="email" maxLength={128} />
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("members.field.properties")}</span>
          <select className="pk-select" name="propertyIds" multiple size={3}>
            {data.properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <button className="pk-button" type="submit">
          {t("members.create.submit")}
        </button>
      </Form>
      <p className="pk-muted">{t("members.create.propertyNote")}</p>
      <p className="pk-muted">{t("members.create.fieldStaffNote")}</p>
    </section>
  );
}
