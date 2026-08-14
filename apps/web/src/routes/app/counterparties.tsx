/**
 * 取引先と料金の設定（PK-SPEC-P5 §2.1・§2.2 / P5-02 / P5-03）。
 *
 *   /app/settings/counterparties
 *
 * task:  docs/tasks/P5-02.md / docs/tasks/P5-03.md
 * ルール: .claude/rules/billing.md §1・§8 / .claude/rules/security.md §1
 *         .claude/rules/ui-writing.md §1
 *
 * ── 2 つを 1 画面にしてある ─────────────────────────────
 * 料金は取引先にぶら下がる（`pricingRule.counterpartyId`）。取引先を
 * 選ばずに料金だけを並べても、どの相手の値段か読めない。**§10 に
 * 画面番号が振られていない**ので（P5 の W- は W-30 / W-31 だけ）、
 * 設定として 1 枚にまとめた。
 *
 * ── 消すボタンが無い ────────────────────────────────────
 * 取引先は「取引中」を外す（`isActive = false`）。料金は終了日を入れる。
 * どちらも過去の請求書が根拠として指しているので、行を消さない。
 *
 * ── 単価は整数（円）だけ ────────────────────────────────
 * billing.md §4。入力欄は `inputMode="numeric"`、小数を受け取らない。
 *
 * ── API と同じことを 2 か所に書いている ─────────────────
 * `routes/api/v1/counterparties.ts` / `pricingRules.ts` と判定・監査ログが
 * 重複している。**片方だけ直さないこと**（W-20 / W-21 / W-25 と同じ形 /
 * DECISIONS #099）。
 */

import {
  INVOICE_ITEM_CODES,
  MAX_CC_EMAILS,
  counterpartyUpsertRequestSchema,
  pricingRuleCreateRequestSchema,
  type CounterpartySummary,
  type InvoiceItemCodeValue,
  type PricingRuleSummary,
} from "@pk/contracts";
import {
  NotFoundError,
  closePricingRule,
  findCounterpartyById,
  insertPricingRule,
  listCounterparties,
  listPricingRules,
  listProperties,
  recordAudit,
  upsertCounterparty,
} from "@pk/db";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { ORGANIZATION_TARGET, assertPermission, can } from "../../lib/auth/permission.js";
import { t, type MessageKey } from "../../lib/i18n.js";
import { getEnv } from "../../lib/ui/cloudflare.js";
import { requireAppContext } from "../../lib/ui/requireSession.js";

/** 品目コードの文言キー。**JSX へ日本語を直書きしない**（ui-writing.md §1）。 */
const ITEM_LABEL: Record<InvoiceItemCodeValue, MessageKey> = {
  CLEAN_CHECKOUT: "invoiceItem.CLEAN_CHECKOUT",
  CLEAN_STAYOVER: "invoiceItem.CLEAN_STAYOVER",
  CLEAN_DEEP: "invoiceItem.CLEAN_DEEP",
  CLEAN_COMMON: "invoiceItem.CLEAN_COMMON",
  REWORK: "invoiceItem.REWORK",
  LINEN_DAMAGE: "invoiceItem.LINEN_DAMAGE",
  EXTRA_REQUEST: "invoiceItem.EXTRA_REQUEST",
  LATE_CHECKOUT: "invoiceItem.LATE_CHECKOUT",
  HOLIDAY_SURCHARGE: "invoiceItem.HOLIDAY_SURCHARGE",
  ADJUSTMENT: "invoiceItem.ADJUSTMENT",
};

const ROUNDING_LABEL = {
  FLOOR: "tax.roundingMode.FLOOR",
  CEIL: "tax.roundingMode.CEIL",
  ROUND: "tax.roundingMode.ROUND",
} as const satisfies Record<string, MessageKey>;

interface CounterpartiesData {
  counterparties: CounterpartySummary[];
  /** 選んでいる取引先。1 件も無ければ `null`。 */
  selectedId: string | null;
  pricingRules: PricingRuleSummary[];
  properties: { id: string; name: string }[];
  canWrite: boolean;
}

/** リポジトリの行を画面の形へ。**`isQualifiedIssuer` は導出**（billing.md §1）。 */
function toSummary(row: {
  id: string;
  code: string;
  legalName: string;
  displayName: string | null;
  invoiceRegistrationNo: string | null;
  postalCode: string | null;
  address1: string | null;
  address2: string | null;
  department: string | null;
  contactName: string | null;
  billingEmail: string;
  ccEmails: string[];
  closingDay: number;
  paymentTermDays: number;
  taxRoundingMode: "FLOOR" | "CEIL" | "ROUND";
  isActive: boolean;
}): CounterpartySummary {
  return { ...row, isQualifiedIssuer: row.invoiceRegistrationNo !== null };
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<CounterpartiesData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "counterparty.read", ORGANIZATION_TARGET);

  const rows = (await listCounterparties(env, tenant, {})).map(toSummary);

  // 選択は URL のクエリ。無ければ先頭（取引中を優先して並べ直さない —
  // 一覧の並びは `code` 順で、画面の並びと選択の既定を一致させる）。
  const requested = new URL(request.url).searchParams.get("counterpartyId");
  const selected =
    requested !== null && rows.some((row) => row.id === requested)
      ? requested
      : (rows[0]?.id ?? null);

  return {
    counterparties: rows,
    selectedId: selected,
    pricingRules:
      selected === null
        ? []
        : await listPricingRules(env, tenant, { counterpartyId: selected }),
    properties: (await listProperties(env, tenant)).map((property) => ({
      id: property.id,
      name: property.name,
    })),
    canWrite: can(tenant, "counterparty.write", ORGANIZATION_TARGET),
  };
}

interface CounterpartiesResult {
  saved?: boolean;
  closed?: boolean;
  duplicateCode?: boolean;
  invalid?: boolean;
}

/** 空文字を `null` に。**フォームは「未入力」を空文字で送ってくる。** */
function orNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** CC のカンマ区切りを配列へ。**空要素を落とす。** */
function ccList(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .slice(0, MAX_CC_EMAILS);
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<CounterpartiesResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "counterparty.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "counterparty") return saveCounterparty(env, tenant, session, form);
  if (intent === "pricingRule") return addPricingRule(env, tenant, session, form);
  if (intent === "closePricingRule") return closeRule(env, tenant, session, form);

  // 未知の意図は 404。**「何もしなかった」を 200 で返さない。**
  throw new NotFoundError();
}

type Env = ReturnType<typeof getEnv>;
type Tenant = Awaited<ReturnType<typeof requireAppContext>>["tenant"];
type Session = Awaited<ReturnType<typeof requireAppContext>>["session"];

/** 取引先の登録・更新（§2.1）。 */
async function saveCounterparty(
  env: Env,
  tenant: Tenant,
  session: Session,
  form: FormData,
): Promise<CounterpartiesResult> {
  const parsed = counterpartyUpsertRequestSchema.safeParse({
    code: form.get("code"),
    legalName: form.get("legalName"),
    displayName: orNull(form.get("displayName")),
    invoiceRegistrationNo: orNull(form.get("invoiceRegistrationNo")),
    postalCode: orNull(form.get("postalCode")),
    address1: orNull(form.get("address1")),
    address2: orNull(form.get("address2")),
    department: orNull(form.get("department")),
    contactName: orNull(form.get("contactName")),
    billingEmail: form.get("billingEmail"),
    ccEmails: ccList(form.get("ccEmails")),
    closingDay: Number(form.get("closingDay")),
    paymentTermDays: Number(form.get("paymentTermDays")),
    taxRoundingMode: form.get("taxRoundingMode"),
    isActive: form.get("isActive") === "on",
  });
  if (!parsed.success) return { invalid: true };

  // 既存かどうかは `counterpartyId`（更新のフォームだけが持つ）で見る。
  const counterpartyId = orNull(form.get("counterpartyId"));
  const before =
    counterpartyId === null ? undefined : await findCounterpartyById(env, tenant, counterpartyId);
  if (counterpartyId !== null && before === undefined) throw new NotFoundError();

  // **コードは付け替えられない**（API と同じ理由 — `uq_cp` を引くため、
  // 別のコードを送ると更新ではなくもう 1 件が生まれる）。
  if (before !== undefined && parsed.data.code !== before.code) return { invalid: true };

  const existing = await listCounterparties(env, tenant, {});
  const duplicate = existing.some(
    (row) => row.code === parsed.data.code && row.id !== counterpartyId,
  );
  if (duplicate) return { duplicateCode: true };

  const { id, created } = await upsertCounterparty(env, tenant, parsed.data);

  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: created ? "counterparty.created" : "counterparty.updated",
    targetType: "counterparty",
    targetId: id,
    ...(before === undefined ? {} : { before: toSummary(before) }),
    after: parsed.data,
  });

  return { saved: true };
}

/** 料金設定の追加（§2.2）。**更新ではない。** */
async function addPricingRule(
  env: Env,
  tenant: Tenant,
  session: Session,
  form: FormData,
): Promise<CounterpartiesResult> {
  const parsed = pricingRuleCreateRequestSchema.safeParse({
    counterpartyId: form.get("counterpartyId"),
    propertyId: orNull(form.get("propertyId")),
    roomTypeId: orNull(form.get("roomTypeId")),
    taskType: orNull(form.get("taskType")),
    itemCode: form.get("itemCode"),
    unitPrice: Number(form.get("unitPrice")),
    taxRate: Number(form.get("taxRate")),
    isReducedRate: form.get("isReducedRate") === "on",
    validFrom: form.get("validFrom"),
    validTo: orNull(form.get("validTo")),
    priority: Number(form.get("priority")),
  });
  if (!parsed.success) return { invalid: true };

  const counterparty = await findCounterpartyById(env, tenant, parsed.data.counterpartyId);
  if (counterparty === undefined) throw new NotFoundError();

  const id = await insertPricingRule(env, tenant, parsed.data);

  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "pricingRule.created",
    targetType: "pricingRule",
    targetId: id,
    ...(parsed.data.propertyId === null ? {} : { propertyId: parsed.data.propertyId }),
    after: parsed.data,
  });

  return { saved: true };
}

/** 料金設定の終了（§2.2）。**終了日だけを書く。** */
async function closeRule(
  env: Env,
  tenant: Tenant,
  session: Session,
  form: FormData,
): Promise<CounterpartiesResult> {
  const pricingRuleId = orNull(form.get("pricingRuleId"));
  const validTo = orNull(form.get("validTo"));
  if (pricingRuleId === null || validTo === null) return { invalid: true };

  const closed = await closePricingRule(env, tenant, pricingRuleId, validTo);
  if (!closed) return { invalid: true };

  await recordAudit(env, tenant, {
    actorId: session.membershipId,
    action: "pricingRule.closed",
    targetType: "pricingRule",
    targetId: pricingRuleId,
    after: { validTo },
  });

  return { closed: true };
}

export default function Counterparties() {
  const data = useLoaderData<CounterpartiesData>();
  const result = useActionData<CounterpartiesResult>();
  const selected = data.counterparties.find((row) => row.id === data.selectedId) ?? null;

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("counterparty.title")}</h1>
      <p className="pk-notice">{t("counterparty.intro")}</p>

      {result?.saved === true ? <p className="pk-message">{t("counterparty.saved")}</p> : null}
      {result?.closed === true ? (
        <p className="pk-message">{t("counterparty.pricing.closed")}</p>
      ) : null}
      {result?.duplicateCode === true ? (
        <p className="pk-notice">{t("counterparty.duplicateCode")}</p>
      ) : null}
      {result?.invalid === true ? <p className="pk-notice">{t("counterparty.invalid")}</p> : null}

      {data.counterparties.length === 0 ? (
        <p className="pk-muted">{t("counterparty.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("counterparty.column.code")}</th>
              <th>{t("counterparty.column.name")}</th>
              <th>{t("counterparty.column.registrationNo")}</th>
              <th>{t("counterparty.column.closing")}</th>
              <th>{t("counterparty.column.payment")}</th>
              <th>{t("counterparty.column.rounding")}</th>
              <th>{t("counterparty.column.status")}</th>
            </tr>
          </thead>
          <tbody>
            {data.counterparties.map((row) => (
              <tr key={row.id} className={row.isActive ? undefined : "pk-row--muted"}>
                <th scope="row">
                  <a href={`/app/settings/counterparties?counterpartyId=${row.id}`}>{row.code}</a>
                </th>
                <td>{row.displayName ?? row.legalName}</td>
                <td>{row.invoiceRegistrationNo ?? "—"}</td>
                <td>{row.closingDay}</td>
                <td>{row.paymentTermDays}</td>
                <td>{t(ROUNDING_LABEL[row.taxRoundingMode])}</td>
                <td>{row.isActive ? t("counterparty.isActive") : t("counterparty.inactive")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.canWrite ? (
        <CounterpartyForm counterparty={selected} />
      ) : (
        <p className="pk-muted">{t("counterparty.readOnly")}</p>
      )}

      {selected === null ? null : (
        <PricingSection
          counterparty={selected}
          rules={data.pricingRules}
          properties={data.properties}
          canWrite={data.canWrite}
        />
      )}
    </section>
  );
}

/** 登録・編集のフォーム。**選んでいる相手があれば編集、無ければ新規。** */
function CounterpartyForm({ counterparty }: { counterparty: CounterpartySummary | null }) {
  return (
    <Form method="post" className="pk-form">
      <input type="hidden" name="intent" value="counterparty" />
      {counterparty === null ? null : (
        <input type="hidden" name="counterpartyId" value={counterparty.id} />
      )}

      <h2>{counterparty === null ? t("counterparty.create") : t("counterparty.save")}</h2>

      {counterparty !== null && !counterparty.isQualifiedIssuer ? (
        <p className="pk-notice pk-notice--info">{t("counterparty.registrationNo.absent")}</p>
      ) : null}

      <label htmlFor="code">{t("counterparty.code")}</label>
      <input
        id="code"
        name="code"
        defaultValue={counterparty?.code ?? ""}
        readOnly={counterparty !== null}
        required
      />
      <p className="pk-hint">{t("counterparty.code.hint")}</p>

      <label htmlFor="legalName">{t("counterparty.legalName")}</label>
      <input id="legalName" name="legalName" defaultValue={counterparty?.legalName ?? ""} required />

      <label htmlFor="displayName">{t("counterparty.displayName")}</label>
      <input id="displayName" name="displayName" defaultValue={counterparty?.displayName ?? ""} />

      <label htmlFor="invoiceRegistrationNo">{t("counterparty.registrationNo")}</label>
      <input
        id="invoiceRegistrationNo"
        name="invoiceRegistrationNo"
        defaultValue={counterparty?.invoiceRegistrationNo ?? ""}
        placeholder={t("counterparty.registrationNo.hint")}
        pattern="T[0-9]{13}"
      />

      <label htmlFor="postalCode">{t("counterparty.postalCode")}</label>
      <input id="postalCode" name="postalCode" defaultValue={counterparty?.postalCode ?? ""} />

      <label htmlFor="address1">{t("counterparty.address1")}</label>
      <input id="address1" name="address1" defaultValue={counterparty?.address1 ?? ""} />

      <label htmlFor="address2">{t("counterparty.address2")}</label>
      <input id="address2" name="address2" defaultValue={counterparty?.address2 ?? ""} />

      <label htmlFor="department">{t("counterparty.department")}</label>
      <input id="department" name="department" defaultValue={counterparty?.department ?? ""} />

      {/* 先方の担当者。**宿泊者の欄ではない**（security.md §3）。 */}
      <label htmlFor="contactName">{t("counterparty.contactName")}</label>
      <input id="contactName" name="contactName" defaultValue={counterparty?.contactName ?? ""} />
      <p className="pk-hint">{t("counterparty.contactName.hint")}</p>

      <label htmlFor="billingEmail">{t("counterparty.billingEmail")}</label>
      <input
        id="billingEmail"
        name="billingEmail"
        type="email"
        defaultValue={counterparty?.billingEmail ?? ""}
        required
      />

      <label htmlFor="ccEmails">{t("counterparty.ccEmails")}</label>
      <input id="ccEmails" name="ccEmails" defaultValue={(counterparty?.ccEmails ?? []).join(", ")} />
      <p className="pk-hint">{t("counterparty.ccEmails.hint")}</p>

      <label htmlFor="closingDay">{t("counterparty.closingDay")}</label>
      <input
        id="closingDay"
        name="closingDay"
        inputMode="numeric"
        defaultValue={String(counterparty?.closingDay ?? 31)}
      />
      <p className="pk-hint">{t("counterparty.closingDay.hint")}</p>

      <label htmlFor="paymentTermDays">{t("counterparty.paymentTermDays")}</label>
      <input
        id="paymentTermDays"
        name="paymentTermDays"
        inputMode="numeric"
        defaultValue={String(counterparty?.paymentTermDays ?? 30)}
      />

      <label htmlFor="taxRoundingMode">{t("counterparty.taxRoundingMode")}</label>
      <select
        id="taxRoundingMode"
        name="taxRoundingMode"
        defaultValue={counterparty?.taxRoundingMode ?? "FLOOR"}
      >
        <option value="FLOOR">{t("tax.roundingMode.FLOOR")}</option>
        <option value="CEIL">{t("tax.roundingMode.CEIL")}</option>
        <option value="ROUND">{t("tax.roundingMode.ROUND")}</option>
      </select>
      <p className="pk-hint">{t("counterparty.taxRoundingMode.hint")}</p>

      <label htmlFor="isActive">{t("counterparty.isActive")}</label>
      <input
        id="isActive"
        name="isActive"
        type="checkbox"
        defaultChecked={counterparty?.isActive ?? true}
      />
      <p className="pk-hint">{t("counterparty.deactivateNote")}</p>

      <button className="pk-button" type="submit">
        {t("counterparty.save")}
      </button>
    </Form>
  );
}

/** 料金設定の一覧と追加（§2.2）。**書き換えの口が無い。** */
function PricingSection({
  counterparty,
  rules,
  properties,
  canWrite,
}: {
  counterparty: CounterpartySummary;
  rules: readonly PricingRuleSummary[];
  properties: readonly { id: string; name: string }[];
  canWrite: boolean;
}) {
  const propertyName = (id: string | null): string =>
    id === null
      ? t("counterparty.pricing.any")
      : (properties.find((property) => property.id === id)?.name ?? id);

  return (
    <section>
      <h2>{t("counterparty.pricing.title")}</h2>
      <p className="pk-muted">{counterparty.displayName ?? counterparty.legalName}</p>
      <p className="pk-notice">{t("counterparty.pricing.intro")}</p>

      {rules.length === 0 ? (
        <p className="pk-muted">{t("counterparty.pricing.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("counterparty.pricing.column.item")}</th>
              <th>{t("counterparty.pricing.column.property")}</th>
              <th>{t("counterparty.pricing.column.roomType")}</th>
              <th>{t("counterparty.pricing.column.taskType")}</th>
              <th>{t("counterparty.pricing.column.unitPrice")}</th>
              <th>{t("counterparty.pricing.column.taxRate")}</th>
              <th>{t("counterparty.pricing.column.period")}</th>
              <th>{t("counterparty.pricing.column.priority")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <th scope="row">{t(ITEM_LABEL[rule.itemCode])}</th>
                <td>{propertyName(rule.propertyId)}</td>
                <td>{rule.roomTypeId ?? t("counterparty.pricing.any")}</td>
                <td>{rule.taskType ?? t("counterparty.pricing.any")}</td>
                <td>{rule.unitPrice}</td>
                <td>
                  {rule.taxRate}
                  {rule.isReducedRate ? ` (${t("counterparty.pricing.reduced")})` : ""}
                </td>
                <td>
                  {rule.validFrom} – {rule.validTo ?? t("counterparty.pricing.open")}
                </td>
                <td>{rule.priority}</td>
                <td>
                  {canWrite && rule.validTo === null ? (
                    <Form method="post" className="pk-inline">
                      <input type="hidden" name="intent" value="closePricingRule" />
                      <input type="hidden" name="pricingRuleId" value={rule.id} />
                      <input type="date" name="validTo" required />
                      <button className="pk-button" type="submit">
                        {t("counterparty.pricing.close")}
                      </button>
                    </Form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite ? (
        <Form method="post" className="pk-form">
          <input type="hidden" name="intent" value="pricingRule" />
          <input type="hidden" name="counterpartyId" value={counterparty.id} />

          <h3>{t("counterparty.pricing.add")}</h3>

          <label htmlFor="itemCode">{t("counterparty.pricing.column.item")}</label>
          <select id="itemCode" name="itemCode" defaultValue="CLEAN_CHECKOUT">
            {INVOICE_ITEM_CODES.map((code) => (
              <option key={code} value={code}>
                {t(ITEM_LABEL[code])}
              </option>
            ))}
          </select>

          <label htmlFor="propertyId">{t("counterparty.pricing.column.property")}</label>
          <select id="propertyId" name="propertyId" defaultValue="">
            <option value="">{t("counterparty.pricing.any")}</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>

          <label htmlFor="taskType">{t("counterparty.pricing.column.taskType")}</label>
          <input id="taskType" name="taskType" />

          {/* 円（税抜）。**整数だけ**（billing.md §4）。 */}
          <label htmlFor="unitPrice">{t("counterparty.pricing.column.unitPrice")}</label>
          <input id="unitPrice" name="unitPrice" inputMode="numeric" defaultValue="0" required />

          <label htmlFor="taxRate">{t("counterparty.pricing.column.taxRate")}</label>
          <input id="taxRate" name="taxRate" inputMode="numeric" defaultValue="10" />

          <label htmlFor="isReducedRate">{t("counterparty.pricing.reduced")}</label>
          <input id="isReducedRate" name="isReducedRate" type="checkbox" />

          <label htmlFor="validFrom">{t("counterparty.pricing.validFrom")}</label>
          <input id="validFrom" name="validFrom" type="date" required />

          <label htmlFor="validTo">{t("counterparty.pricing.validTo")}</label>
          <input id="validTo" name="validTo" type="date" />

          <label htmlFor="priority">{t("counterparty.pricing.column.priority")}</label>
          <input id="priority" name="priority" inputMode="numeric" defaultValue="50" />
          <p className="pk-hint">{t("counterparty.pricing.priorityHint")}</p>

          <button className="pk-button" type="submit">
            {t("counterparty.pricing.add")}
          </button>
        </Form>
      ) : null}
    </section>
  );
}
