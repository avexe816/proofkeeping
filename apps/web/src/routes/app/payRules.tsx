/**
 * 支払単価の設定（P5-18 / docs/PK-SPEC-PAY.md §1.1・§1.2）。
 *
 *   /app/settings/pay-rules
 *
 * task:  docs/tasks/P5-18.md
 * ルール: .claude/rules/billing.md §4 / security.md §5
 *
 * ── 門は `payout.write`（OWNER / ORG_ADMIN のみ）────────
 * 単価は PROPERTY_MANAGER にも見せない（P8 §1.3 の踏襲 / PAY §4）。
 *
 * ── 単価の変更は行の追加 ────────────────────────────────
 * 既存行の金額は書き換えられない。値上げは旧行を閉じて新行を足す
 * （`pricingRule` と同じ。確定済みの支払の根拠が動かない）。
 */

import {
  closePayRule,
  insertPayRule,
  listOrgMembers,
  listPayRules,
  listProperties,
  listStaffPayProfiles,
  recordAudit,
  upsertStaffPayProfile,
  type EmploymentType,
  type PayUnitType,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission } from "../../lib/auth/permission.js";
import { businessDateOf } from "../../lib/businessDate.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

const EMPLOYMENT_OPTIONS = ["FULL_TIME", "PART_TIME", "CONTRACTOR"] as const;

const EMPLOYMENT_LABEL: Record<EmploymentType, MessageKey> = {
  FULL_TIME: "payRules.employment.fullTime",
  PART_TIME: "payRules.employment.partTime",
  CONTRACTOR: "payRules.employment.contractor",
};

const TASK_TYPE_OPTIONS = ["CHECKOUT", "STAYOVER", "DEEP", "COMMON_AREA", "RECHECK"] as const;

interface PayRuleRow {
  id: string;
  staffLabel: string | null;
  propertyLabel: string | null;
  taskType: string | null;
  unitType: PayUnitType;
  unitPrice: number;
  validFrom: string | null;
  validTo: string | null;
  priority: number;
}

interface PayRulesData {
  rules: PayRuleRow[];
  staff: { membershipId: string; label: string; employmentType: EmploymentType | null }[];
  properties: { id: string; name: string }[];
}

export async function loader({ request, context }: LoaderFunctionArgs): Promise<PayRulesData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  // 設定画面なので読みから write の門で守る（単価の閲覧 = 実質の設定情報）。
  assertPermission(tenant, "payout.write", ORGANIZATION_TARGET);

  const [rules, members, profiles, properties] = await Promise.all([
    listPayRules(env, tenant),
    listOrgMembers(env, tenant),
    listStaffPayProfiles(env, tenant),
    listProperties(env, tenant, { isActive: true }),
  ]);
  const memberOf = new Map(members.map((member) => [member.membershipId, member]));
  const profileOf = new Map(profiles.map((profile) => [profile.membershipId, profile]));
  const propertyOf = new Map(properties.map((property) => [property.id, property.name]));

  // 現場ロールを先に出す（支払対象の大半）。管理系も外注のことがあるので出す。
  const fieldRoles: readonly string[] = ["CLEANER", "INSPECTOR"];
  const staff = members
    .filter((member) => member.isActive)
    .sort((a, b) => {
      const aField = fieldRoles.includes(a.role) ? 0 : 1;
      const bField = fieldRoles.includes(b.role) ? 0 : 1;
      return aField - bField || a.staffNumber.localeCompare(b.staffNumber);
    })
    .map((member) => ({
      membershipId: member.membershipId,
      label: `${member.displayName}（${member.staffNumber}）`,
      employmentType: profileOf.get(member.membershipId)?.employmentType ?? null,
    }));

  return {
    rules: rules.map((rule) => ({
      id: rule.id,
      staffLabel:
        rule.membershipId === null
          ? null
          : (memberOf.get(rule.membershipId)?.displayName ?? rule.membershipId),
      propertyLabel:
        rule.propertyId === null ? null : (propertyOf.get(rule.propertyId) ?? rule.propertyId),
      taskType: rule.taskType,
      unitType: rule.unitType,
      unitPrice: rule.unitPrice,
      validFrom: rule.validFrom,
      validTo: rule.validTo,
      priority: rule.priority,
    })),
    staff,
    properties: properties.map((property) => ({ id: property.id, name: property.name })),
  };
}

type PayRulesFailure = "INVALID";

interface PayRulesActionResult {
  created?: boolean;
  closed?: boolean;
  profileSaved?: boolean;
  failure?: PayRulesFailure;
}

function textOf(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > maxLength ? null : trimmed;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<PayRulesActionResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "payout.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "createRule") {
    const membershipId = textOf(form.get("membershipId"), 64);
    const propertyId = textOf(form.get("propertyId"), 64);
    const taskTypeRaw = textOf(form.get("taskType"), 16);
    const taskType = TASK_TYPE_OPTIONS.find((option) => option === taskTypeRaw) ?? null;
    const unitTypeRaw = form.get("unitType");
    const unitType = unitTypeRaw === "PER_TASK" || unitTypeRaw === "HOURLY" ? unitTypeRaw : null;
    const unitPriceRaw = textOf(form.get("unitPrice"), 9);
    const unitPrice = unitPriceRaw === null ? Number.NaN : Number(unitPriceRaw);
    const validFrom = textOf(form.get("validFrom"), 10);
    if (unitType === null || !Number.isInteger(unitPrice) || unitPrice < 0) {
      return { failure: "INVALID" };
    }
    if (validFrom !== null && !DATE_PATTERN.test(validFrom)) return { failure: "INVALID" };
    // 表せる段（PAY §1.2 の 5 段階）に丸める前に、意味の無い組み合わせを弾く。
    // 「施設だけ」の行はどの段にも当たらず、静かに効かない単価になる。
    if (membershipId === null && propertyId !== null && taskType === null) {
      return { failure: "INVALID" };
    }
    if (membershipId !== null && propertyId !== null && taskType === null) {
      return { failure: "INVALID" };
    }

    const created = await insertPayRule(env, tenant, {
      membershipId,
      propertyId,
      taskType,
      unitType,
      unitPrice,
      validFrom,
      validTo: null,
      priority: 100,
    });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "payRule.created",
      targetType: "payRule",
      targetId: created.id,
      after: { membershipId, propertyId, taskType, unitType, unitPrice, validFrom },
    });
    return { created: true };
  }

  if (intent === "closeRule") {
    const payRuleId = textOf(form.get("payRuleId"), 64);
    if (payRuleId === null) return { failure: "INVALID" };
    // 今日（業務日）で閉じる。**行は消さない**（確定済みの支払の根拠）。
    const closedOn = businessDateOf(now);
    const changed = await closePayRule(env, tenant, payRuleId, closedOn);
    if (changed === 0) return { failure: "INVALID" };
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "payRule.closed",
      targetType: "payRule",
      targetId: payRuleId,
      after: { validTo: closedOn },
    });
    return { closed: true };
  }

  if (intent === "profile") {
    const membershipId = textOf(form.get("membershipId"), 64);
    const employmentTypeRaw = form.get("employmentType");
    const employmentType = EMPLOYMENT_OPTIONS.find((option) => option === employmentTypeRaw);
    const invoiceRegistrationNo = textOf(form.get("invoiceRegistrationNo"), 14);
    if (membershipId === null || employmentType === undefined) return { failure: "INVALID" };
    if (invoiceRegistrationNo !== null && !/^T\d{13}$/.test(invoiceRegistrationNo)) {
      return { failure: "INVALID" };
    }

    await upsertStaffPayProfile(env, tenant, {
      membershipId,
      employmentType,
      invoiceRegistrationNo: employmentType === "CONTRACTOR" ? invoiceRegistrationNo : null,
      isActive: true,
    });
    await recordAudit(env, tenant, {
      actorId: session.membershipId,
      action: "staffPayProfile.updated",
      targetType: "staffPayProfile",
      targetId: membershipId,
      after: { employmentType },
    });
    return { profileSaved: true };
  }

  return { failure: "INVALID" };
}

function yen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

export default function PayRules() {
  const data = useLoaderData<PayRulesData>();
  const result = useActionData<PayRulesActionResult>();

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("payRules.title")}</h1>
      </div>
      <p className="pk-muted">{t("payRules.lede")}</p>

      {result?.failure !== undefined ? (
        <p className="pk-notice pk-notice--warn">{t("payRules.error.invalid")}</p>
      ) : null}
      {result?.created === true ? <p className="pk-notice">{t("payRules.created")}</p> : null}
      {result?.closed === true ? <p className="pk-notice">{t("payRules.closed")}</p> : null}
      {result?.profileSaved === true ? <p className="pk-notice">{t("payRules.profileSaved")}</p> : null}

      {/* ── 単価の一覧 ─────────────────────────────────── */}
      <h2 className="pk-section__title">{t("payRules.list.title")}</h2>
      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("payRules.column.staff")}</th>
            <th>{t("payRules.column.property")}</th>
            <th>{t("payRules.column.taskType")}</th>
            <th>{t("payRules.column.unit")}</th>
            <th>{t("payRules.column.price")}</th>
            <th>{t("payRules.column.validity")}</th>
            <th>{t("payRules.column.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {data.rules.map((rule) => (
            <tr key={rule.id}>
              <th scope="row">{rule.staffLabel ?? t("payRules.any")}</th>
              <td>{rule.propertyLabel ?? t("payRules.any")}</td>
              <td>{rule.taskType ?? t("payRules.any")}</td>
              <td>
                {rule.unitType === "PER_TASK" ? t("payRules.unit.perTask") : t("payRules.unit.hourly")}
              </td>
              <td>{yen(rule.unitPrice)}</td>
              <td>{`${rule.validFrom ?? "—"} 〜 ${rule.validTo ?? "—"}`}</td>
              <td>
                {rule.validTo === null ? (
                  <Form method="post" className="pk-inlineform">
                    <input type="hidden" name="intent" value="closeRule" />
                    <input type="hidden" name="payRuleId" value={rule.id} />
                    <button className="pk-button" type="submit">
                      {t("payRules.action.close")}
                    </button>
                  </Form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.rules.length === 0 ? <p className="pk-muted">{t("payRules.empty")}</p> : null}
      <p className="pk-muted">{t("payRules.changeNote")}</p>

      {/* ── 単価の追加 ─────────────────────────────────── */}
      <h2 className="pk-section__title">{t("payRules.create.title")}</h2>
      <Form method="post" className="pk-filter">
        <input type="hidden" name="intent" value="createRule" />
        <label className="pk-field">
          <span className="pk-field__label">{t("payRules.column.staff")}</span>
          <select className="pk-select" name="membershipId" defaultValue="">
            <option value="">{t("payRules.any")}</option>
            {data.staff.map((member) => (
              <option key={member.membershipId} value={member.membershipId}>
                {member.label}
              </option>
            ))}
          </select>
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("payRules.column.property")}</span>
          <select className="pk-select" name="propertyId" defaultValue="">
            <option value="">{t("payRules.any")}</option>
            {data.properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("payRules.column.taskType")}</span>
          <select className="pk-select" name="taskType" defaultValue="">
            <option value="">{t("payRules.any")}</option>
            {TASK_TYPE_OPTIONS.map((taskType) => (
              <option key={taskType} value={taskType}>
                {taskType}
              </option>
            ))}
          </select>
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("payRules.column.unit")}</span>
          <select className="pk-select" name="unitType" defaultValue="PER_TASK">
            <option value="PER_TASK">{t("payRules.unit.perTask")}</option>
            <option value="HOURLY">{t("payRules.unit.hourly")}</option>
          </select>
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("payRules.column.price")}</span>
          <input className="pk-input" name="unitPrice" required inputMode="numeric" pattern="[0-9]+" />
        </label>
        <label className="pk-field">
          <span className="pk-field__label">{t("payRules.field.validFrom")}</span>
          <input className="pk-input" name="validFrom" type="date" />
        </label>
        <button className="pk-button" type="submit">
          {t("payRules.create.submit")}
        </button>
      </Form>
      <p className="pk-muted">{t("payRules.stageNote")}</p>

      {/* ── 雇用区分 ───────────────────────────────────── */}
      <h2 className="pk-section__title">{t("payRules.profile.title")}</h2>
      <p className="pk-muted">{t("payRules.profile.lede")}</p>
      <table className="pk-grid">
        <thead>
          <tr>
            <th>{t("payRules.column.staff")}</th>
            <th>{t("payRules.profile.employment")}</th>
            <th>{t("payRules.profile.save")}</th>
          </tr>
        </thead>
        <tbody>
          {data.staff.map((member) => (
            <tr key={member.membershipId}>
              <th scope="row">{member.label}</th>
              <td colSpan={2}>
                <Form method="post" className="pk-inlineform">
                  <input type="hidden" name="intent" value="profile" />
                  <input type="hidden" name="membershipId" value={member.membershipId} />
                  <select
                    className="pk-select"
                    name="employmentType"
                    defaultValue={member.employmentType ?? "PART_TIME"}
                  >
                    {EMPLOYMENT_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {t(EMPLOYMENT_LABEL[option])}
                      </option>
                    ))}
                  </select>
                  <input
                    className="pk-input"
                    name="invoiceRegistrationNo"
                    maxLength={14}
                    placeholder={t("payRules.profile.registrationNo")}
                  />
                  <button className="pk-button" type="submit">
                    {t("payRules.profile.saveButton")}
                  </button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pk-muted">{t("payRules.profile.note")}</p>
    </section>
  );
}
