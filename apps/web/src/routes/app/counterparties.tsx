/**
 * 取引先と料金の設定（PK-SPEC-P5 §2.1・§2.2・§3.2）。
 *
 *   /app/settings/counterparties
 *
 * task:  docs/tasks/P5-02.md（取引先の登録・編集）/ docs/tasks/P5-03.md
 * ルール: .claude/rules/billing.md §1・§8 / .claude/rules/security.md §1
 *         .claude/rules/ui-writing.md §1
 *
 * ── なぜ画面が要るか ────────────────────────────────────
 * P5-02 の「やること」は「取引先の登録・編集」。API（§9）だけでは
 * **画面から取引先を 1 件も作れない。** 月次締め（W-30）も 1 クリック発行
 * （§4.1）も、取引先と料金が入っている前提の画面になる。
 *
 * ── 2 つを 1 枚にしてある ───────────────────────────────
 * 料金は取引先にぶら下がる（`pricingRule.counterpartyId`）。取引先を
 * 選ばずに料金だけを並べても、どの相手の値段か読めない。
 * **P5 に画面番号が無い**（§10 の `W-` は W-30 と W-31 だけ）ので、
 * 設定として 1 枚にまとめた。相手は `?counterpartyId=` で選ぶ。
 *
 * ── 消すボタンが無い ────────────────────────────────────
 * 取引先は「取引中」を外す（`isActive = false`）。料金は終了日を入れる。
 * どちらも過去の請求書が根拠として指している（CLAUDE.md §4）。
 *
 * ── 選ばれない料金設定を作らせない ──────────────────────
 * §3.2 の梯子に載らない形（例: 施設 + 客室タイプ）は API が 400 で断る
 * （DECISIONS #123）。**画面はそもそも組ませない。** 「適用範囲」を
 * 5 段から選ばせ、その段が使わない軸はサーバー側で落とす。
 * 400 を見せて直させるより、選べない形にするほうが早い。
 *
 * ── API と同じことを 2 か所に書いている ─────────────────
 * `routes/api/v1/counterparties.ts` / `pricingRules.ts` と判定・監査ログが
 * 重複している。**片方だけ直さないこと**（W-20 / W-21 / W-25 と同じ形 /
 * DECISIONS #099）。
 */

import { pricingRuleStage } from "@pk/billing";
import {
  INVOICE_ITEM_CODES,
  TASK_TYPES,
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  pricingRuleCloseSchema,
  pricingRuleCreateSchema,
  type CounterpartySummary,
  type PricingRuleSummary,
  type TaskTypeValue,
} from "@pk/contracts";
import {
  NotFoundError,
  closePricingRule,
  findCounterpartyById,
  insertPricingRule,
  listCounterparties,
  listPricingRules,
  listProperties,
  listRoomTypes,
  recordAudit,
  updateCounterparty,
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

/**
 * 品目コードの文言キー（§2.4）。
 *
 * **`@pk/billing` の `ITEM_CODE_LABELS` を使わない。** あちらは帳票の
 * 明細に載る文字列で、画面の文言は i18n を通す（ui-writing.md §1）。
 * 同じ語を 2 か所に置いているのは意図的。
 */
const ITEM_LABEL: Record<(typeof INVOICE_ITEM_CODES)[number], MessageKey> = {
  CLEAN_CHECKOUT: "cp.item.CLEAN_CHECKOUT",
  CLEAN_STAYOVER: "cp.item.CLEAN_STAYOVER",
  CLEAN_DEEP: "cp.item.CLEAN_DEEP",
  CLEAN_COMMON: "cp.item.CLEAN_COMMON",
  REWORK: "cp.item.REWORK",
  LINEN_DAMAGE: "cp.item.LINEN_DAMAGE",
  EXTRA_REQUEST: "cp.item.EXTRA_REQUEST",
  LATE_CHECKOUT: "cp.item.LATE_CHECKOUT",
  HOLIDAY_SURCHARGE: "cp.item.HOLIDAY_SURCHARGE",
  ADJUSTMENT: "cp.item.ADJUSTMENT",
};

const TASK_TYPE_LABEL: Record<TaskTypeValue, MessageKey> = {
  CHECKOUT: "cp.taskType.CHECKOUT",
  STAYOVER: "cp.taskType.STAYOVER",
  DEEP: "cp.taskType.DEEP",
  COMMON_AREA: "cp.taskType.COMMON_AREA",
  RECHECK: "cp.taskType.RECHECK",
};

const ROUNDING_LABEL = {
  FLOOR: "tax.roundingMode.FLOOR",
  CEIL: "tax.roundingMode.CEIL",
  ROUND: "tax.roundingMode.ROUND",
} as const satisfies Record<string, MessageKey>;

/** §3.2 の 5 段。**画面はこの順で選ばせる。** */
const STAGE_LABEL = {
  1: "cp.stage.1",
  2: "cp.stage.2",
  3: "cp.stage.3",
  4: "cp.stage.4",
  5: "cp.stage.5",
} as const satisfies Record<number, MessageKey>;

const STAGES = [1, 2, 3, 4, 5] as const;

type Stage = (typeof STAGES)[number];

/** 客室タイプの選択肢。**施設とセットで持つ**（段 1 は施設を含むため）。 */
interface RoomTypeOption {
  propertyId: string;
  propertyName: string;
  roomTypeId: string;
  roomTypeName: string;
}

interface CounterpartiesData {
  counterparties: CounterpartySummary[];
  selectedId: string | null;
  pricingRules: PricingRuleSummary[];
  properties: { id: string; name: string }[];
  roomTypes: RoomTypeOption[];
  canWrite: boolean;
}

/** リポジトリの行を画面の形へ。**`organizationId` を落とす。** */
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
  return {
    counterpartyId: row.id,
    code: row.code,
    legalName: row.legalName,
    displayName: row.displayName,
    invoiceRegistrationNo: row.invoiceRegistrationNo,
    postalCode: row.postalCode,
    address1: row.address1,
    address2: row.address2,
    department: row.department,
    contactName: row.contactName,
    billingEmail: row.billingEmail,
    ccEmails: row.ccEmails,
    closingDay: row.closingDay,
    paymentTermDays: row.paymentTermDays,
    taxRoundingMode: row.taxRoundingMode,
    isActive: row.isActive,
  };
}

/** 料金設定 1 件。**`stage` は API と同じく `packages/billing` に聞く。** */
function toRuleSummary(row: {
  id: string;
  counterpartyId: string;
  propertyId: string | null;
  roomTypeId: string | null;
  taskType: string | null;
  itemCode: (typeof INVOICE_ITEM_CODES)[number];
  unitPrice: number;
  taxRate: number;
  isReducedRate: boolean;
  validFrom: string;
  validTo: string | null;
  priority: number;
}): PricingRuleSummary {
  return {
    pricingRuleId: row.id,
    counterpartyId: row.counterpartyId,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    taskType: row.taskType,
    itemCode: row.itemCode,
    unitPrice: row.unitPrice,
    taxRate: row.taxRate,
    isReducedRate: row.isReducedRate,
    validFrom: row.validFrom,
    validTo: row.validTo,
    priority: row.priority,
    stage: pricingRuleStage(row),
  };
}

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<CounterpartiesData> {
  const env = getEnv(context);
  const now = new Date();
  const { tenant } = await requireAppContext(env, request, now);
  // **`INSPECTOR` / `CLEANER` はここで 404**（security.md §1）。
  assertPermission(tenant, "billing.read", ORGANIZATION_TARGET);

  const rows = (await listCounterparties(env, tenant)).map(toSummary);

  // 選択は URL のクエリ。無ければ先頭（一覧と同じ `code` 順）。
  const requested = new URL(request.url).searchParams.get("counterpartyId");
  const selected =
    requested !== null && rows.some((row) => row.counterpartyId === requested)
      ? requested
      : (rows[0]?.counterpartyId ?? null);

  const properties = (await listProperties(env, tenant)).map((property) => ({
    id: property.id,
    name: property.name,
  }));

  // **客室タイプは施設ごとに引く**（`listRoomTypes()` が施設を要る）。
  // 施設は組織のマスタで数が知れているため、まとめて持って画面で絞る。
  const roomTypes: RoomTypeOption[] = [];
  for (const property of properties) {
    for (const type of await listRoomTypes(env, tenant, property.id)) {
      roomTypes.push({
        propertyId: property.id,
        propertyName: property.name,
        roomTypeId: type.id,
        roomTypeName: type.name,
      });
    }
  }

  return {
    counterparties: rows,
    selectedId: selected,
    pricingRules:
      selected === null
        ? []
        : (await listPricingRules(env, tenant, { counterpartyId: selected })).map(toRuleSummary),
    properties,
    roomTypes,
    canWrite: can(tenant, "billing.write", ORGANIZATION_TARGET),
  };
}

interface CounterpartiesResult {
  saved?: boolean;
  closed?: boolean;
  duplicateCode?: boolean;
  invalid?: boolean;
}

/** 空文字を `undefined` に。**contracts 側が `optional()` で受ける形に合わせる。** */
function orUndefined(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** CC のカンマ区切りを配列へ。**空要素を落とす。** */
function ccList(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export async function action({
  request,
  context,
}: ActionFunctionArgs): Promise<CounterpartiesResult> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "billing.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");
  const actorId = session.membershipId;

  if (intent === "createCounterparty") return createCounterparty(env, tenant, actorId, form);
  if (intent === "updateCounterparty") return editCounterparty(env, tenant, actorId, form);
  if (intent === "createPricingRule") return createPricingRule(env, tenant, actorId, form);
  if (intent === "closePricingRule") return closeRule(env, tenant, actorId, form);

  // 未知の意図は 404。**「何もしなかった」を 200 で返さない。**
  throw new NotFoundError();
}

type Env = ReturnType<typeof getEnv>;
type Tenant = Awaited<ReturnType<typeof requireAppContext>>["tenant"];

/**
 * 監査ログに残す項目。
 *
 * **住所・担当者名を含めない**（API 側の `auditPayload()` と同じ理由 —
 * 取引先の担当者は個人で、消せない表に積む理由が無い）。
 */
function auditPayload(row: {
  legalName?: string | null | undefined;
  billingEmail?: string | null | undefined;
  ccEmails?: readonly string[] | undefined;
  closingDay?: number | undefined;
  paymentTermDays?: number | undefined;
  taxRoundingMode?: string | undefined;
  invoiceRegistrationNo?: string | null | undefined;
  isActive?: boolean | undefined;
}): Record<string, unknown> {
  return {
    legalName: row.legalName ?? null,
    billingEmail: row.billingEmail ?? null,
    ccEmailCount: row.ccEmails?.length ?? 0,
    closingDay: row.closingDay ?? null,
    paymentTermDays: row.paymentTermDays ?? null,
    taxRoundingMode: row.taxRoundingMode ?? null,
    hasRegistrationNo: (row.invoiceRegistrationNo ?? null) !== null,
    isActive: row.isActive ?? null,
  };
}

/** フォームから取引先の項目を拾う。**作成と更新で同じ欄。** */
function counterpartyFields(form: FormData): Record<string, unknown> {
  return {
    legalName: form.get("legalName"),
    displayName: orUndefined(form.get("displayName")) ?? "",
    invoiceRegistrationNo: orUndefined(form.get("invoiceRegistrationNo")) ?? "",
    postalCode: orUndefined(form.get("postalCode")) ?? "",
    address1: orUndefined(form.get("address1")) ?? "",
    address2: orUndefined(form.get("address2")) ?? "",
    department: orUndefined(form.get("department")) ?? "",
    contactName: orUndefined(form.get("contactName")) ?? "",
    billingEmail: form.get("billingEmail"),
    ccEmails: ccList(form.get("ccEmails")),
    closingDay: Number(form.get("closingDay")),
    paymentTermDays: Number(form.get("paymentTermDays")),
    taxRoundingMode: form.get("taxRoundingMode"),
  };
}

/** 新規登録（§2.1）。**既存コードに当たったら 409 相当**（画面は文言で返す）。 */
async function createCounterparty(
  env: Env,
  tenant: Tenant,
  actorId: string,
  form: FormData,
): Promise<CounterpartiesResult> {
  const parsed = counterpartyCreateSchema.safeParse({
    code: form.get("code"),
    ...counterpartyFields(form),
  });
  if (!parsed.success) return { invalid: true };

  // **上書きにならないよう先に見る**（API 側と同じ / `upsertCounterparty()`
  // はコード一致で更新へ落ちる）。
  const existing = await listCounterparties(env, tenant);
  if (existing.some((row) => row.code === parsed.data.code)) return { duplicateCode: true };

  const input = parsed.data;
  const result = await upsertCounterparty(env, tenant, {
    code: input.code,
    legalName: input.legalName,
    displayName: input.displayName ?? null,
    invoiceRegistrationNo: input.invoiceRegistrationNo ?? null,
    postalCode: input.postalCode ?? null,
    address1: input.address1 ?? null,
    address2: input.address2 ?? null,
    department: input.department ?? null,
    contactName: input.contactName ?? null,
    billingEmail: input.billingEmail,
    ccEmails: input.ccEmails ?? [],
    closingDay: input.closingDay ?? 31,
    paymentTermDays: input.paymentTermDays ?? 30,
    taxRoundingMode: input.taxRoundingMode ?? "FLOOR",
    isActive: true,
  });

  await recordAudit(env, tenant, {
    actorId,
    action: "counterparty.created",
    targetType: "counterparty",
    targetId: result.id,
    after: auditPayload(input),
  });

  return { saved: true };
}

/** 更新・無効化（§2.1）。**`code` は送らない**（contracts が持たない）。 */
async function editCounterparty(
  env: Env,
  tenant: Tenant,
  actorId: string,
  form: FormData,
): Promise<CounterpartiesResult> {
  const counterpartyId = orUndefined(form.get("counterpartyId"));
  if (counterpartyId === undefined) return { invalid: true };

  const parsed = counterpartyUpdateSchema.safeParse({
    ...counterpartyFields(form),
    isActive: form.get("isActive") === "on",
  });
  if (!parsed.success) return { invalid: true };

  const before = await findCounterpartyById(env, tenant, counterpartyId);
  if (before === undefined) throw new NotFoundError();

  await updateCounterparty(env, tenant, counterpartyId, parsed.data);

  await recordAudit(env, tenant, {
    actorId,
    action: "counterparty.updated",
    targetType: "counterparty",
    targetId: counterpartyId,
    before: auditPayload(before),
    after: auditPayload(parsed.data),
  });

  return { saved: true };
}

/**
 * 料金設定の追加（§2.2）。
 *
 * **適用範囲（段）が軸を決める。** その段が使わない軸は落とす。
 * 段 1 の客室タイプは `施設::客室タイプ` の形で届き、施設もそこから取る
 * （別々の欄にすると、施設 A と施設 B の客室タイプを組み合わせられる）。
 */
async function createPricingRule(
  env: Env,
  tenant: Tenant,
  actorId: string,
  form: FormData,
): Promise<CounterpartiesResult> {
  const counterpartyId = orUndefined(form.get("counterpartyId"));
  const stage = Number(form.get("stage"));
  if (counterpartyId === undefined || !STAGES.includes(stage as Stage)) return { invalid: true };

  const [pairProperty, pairRoomType] = (orUndefined(form.get("propertyRoomTypeId")) ?? "").split(
    "::",
  );
  const propertyId = orUndefined(form.get("propertyId"));
  const taskType = orUndefined(form.get("taskType"));

  // 段ごとに使う軸だけを組む。**ここで `pricingRuleStage()` と一致させる。**
  const shape =
    stage === 1
      ? { propertyId: pairProperty ?? null, roomTypeId: pairRoomType ?? null, taskType }
      : stage === 2
        ? { propertyId: propertyId ?? null, roomTypeId: null, taskType }
        : stage === 3
          ? { propertyId: propertyId ?? null, roomTypeId: null, taskType: null }
          : stage === 4
            ? { propertyId: null, roomTypeId: null, taskType }
            : { propertyId: null, roomTypeId: null, taskType: null };

  const parsed = pricingRuleCreateSchema.safeParse({
    counterpartyId,
    ...shape,
    itemCode: form.get("itemCode"),
    unitPrice: Number(form.get("unitPrice")),
    taxRate: Number(form.get("taxRate")),
    isReducedRate: form.get("isReducedRate") === "on",
    validFrom: form.get("validFrom"),
    validTo: orUndefined(form.get("validTo")) ?? null,
    priority: Number(form.get("priority")),
  });
  if (!parsed.success) return { invalid: true };

  const input = parsed.data;
  const resolved = {
    propertyId: input.propertyId ?? null,
    roomTypeId: input.roomTypeId ?? null,
    taskType: input.taskType ?? null,
  };
  // 画面が組ませない形だが、**念のため保存の前に確かめる**（API と同じ門）。
  if (pricingRuleStage(resolved) === null) return { invalid: true };

  if (input.validTo !== undefined && input.validTo !== null && input.validTo < input.validFrom) {
    return { invalid: true };
  }

  const counterparty = await findCounterpartyById(env, tenant, counterpartyId);
  if (counterparty === undefined) throw new NotFoundError();

  const pricingRuleId = await insertPricingRule(env, tenant, {
    counterpartyId,
    ...resolved,
    itemCode: input.itemCode,
    unitPrice: input.unitPrice,
    taxRate: input.taxRate ?? 10,
    isReducedRate: input.isReducedRate ?? false,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    priority: input.priority ?? 50,
  });

  await recordAudit(env, tenant, {
    actorId,
    action: "pricingRule.created",
    targetType: "pricingRule",
    targetId: pricingRuleId,
    ...(resolved.propertyId === null ? {} : { propertyId: resolved.propertyId }),
    after: {
      counterpartyId,
      ...resolved,
      itemCode: input.itemCode,
      unitPrice: input.unitPrice,
      taxRate: input.taxRate ?? 10,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
    },
  });

  return { saved: true };
}

/** 期間を閉じる（§2.2）。**`validTo` だけ。** */
async function closeRule(
  env: Env,
  tenant: Tenant,
  actorId: string,
  form: FormData,
): Promise<CounterpartiesResult> {
  const pricingRuleId = orUndefined(form.get("pricingRuleId"));
  if (pricingRuleId === undefined) return { invalid: true };

  const parsed = pricingRuleCloseSchema.safeParse({ validTo: form.get("validTo") });
  if (!parsed.success) return { invalid: true };

  const closed = await closePricingRule(env, tenant, pricingRuleId, parsed.data.validTo);
  // 開始日より前へは閉じない（`closePricingRule()` の注記）。
  if (!closed) return { invalid: true };

  await recordAudit(env, tenant, {
    actorId,
    action: "pricingRule.closed",
    targetType: "pricingRule",
    targetId: pricingRuleId,
    after: { validTo: parsed.data.validTo },
  });

  return { closed: true };
}

export default function Counterparties() {
  const data = useLoaderData<CounterpartiesData>();
  const result = useActionData<CounterpartiesResult>();
  const selected =
    data.counterparties.find((row) => row.counterpartyId === data.selectedId) ?? null;

  return (
    <section className="pk-page">
      <h1 className="pk-page__title">{t("cp.title")}</h1>
      <p className="pk-notice">{t("cp.intro")}</p>

      {result?.saved === true ? <p className="pk-message">{t("cp.saved")}</p> : null}
      {result?.closed === true ? <p className="pk-message">{t("cp.pricing.closed")}</p> : null}
      {result?.duplicateCode === true ? <p className="pk-notice">{t("cp.duplicateCode")}</p> : null}
      {result?.invalid === true ? <p className="pk-notice">{t("cp.invalid")}</p> : null}

      {data.counterparties.length === 0 ? (
        <p className="pk-muted">{t("cp.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("cp.column.code")}</th>
              <th>{t("cp.column.name")}</th>
              <th>{t("cp.column.registrationNo")}</th>
              <th>{t("cp.column.closing")}</th>
              <th>{t("cp.column.payment")}</th>
              <th>{t("cp.column.rounding")}</th>
              <th>{t("cp.column.status")}</th>
            </tr>
          </thead>
          <tbody>
            {data.counterparties.map((row) => (
              <tr
                key={row.counterpartyId}
                className={row.isActive ? undefined : "pk-row--muted"}
              >
                <th scope="row">
                  <a href={`/app/settings/counterparties?counterpartyId=${row.counterpartyId}`}>
                    {row.code}
                  </a>
                </th>
                <td>{row.displayName ?? row.legalName}</td>
                <td>{row.invoiceRegistrationNo ?? t("cp.registrationNo.none")}</td>
                <td>{row.closingDay}</td>
                <td>{row.paymentTermDays}</td>
                <td>{t(ROUNDING_LABEL[row.taxRoundingMode])}</td>
                <td>{row.isActive ? t("cp.active") : t("cp.inactive")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.canWrite ? null : <p className="pk-muted">{t("cp.readOnly")}</p>}

      {data.canWrite && selected !== null ? <EditForm counterparty={selected} /> : null}
      {data.canWrite ? <CreateForm /> : null}

      {selected === null ? null : (
        <PricingSection
          counterparty={selected}
          rules={data.pricingRules}
          properties={data.properties}
          roomTypes={data.roomTypes}
          canWrite={data.canWrite}
        />
      )}
    </section>
  );
}

/** 取引先の共通の入力欄。**作成と更新で同じ並び。** */
function CounterpartyFields({ counterparty }: { counterparty: CounterpartySummary | null }) {
  const idFor = (name: string): string =>
    counterparty === null ? `new-${name}` : `edit-${name}`;

  return (
    <>
      <label htmlFor={idFor("legalName")}>{t("cp.legalName")}</label>
      <input
        id={idFor("legalName")}
        name="legalName"
        defaultValue={counterparty?.legalName ?? ""}
        required
      />

      <label htmlFor={idFor("displayName")}>{t("cp.displayName")}</label>
      <input
        id={idFor("displayName")}
        name="displayName"
        defaultValue={counterparty?.displayName ?? ""}
      />

      <label htmlFor={idFor("invoiceRegistrationNo")}>{t("cp.registrationNo")}</label>
      <input
        id={idFor("invoiceRegistrationNo")}
        name="invoiceRegistrationNo"
        defaultValue={counterparty?.invoiceRegistrationNo ?? ""}
        placeholder={t("cp.registrationNo.hint")}
        pattern="T[0-9]{13}"
      />

      <label htmlFor={idFor("postalCode")}>{t("cp.postalCode")}</label>
      <input
        id={idFor("postalCode")}
        name="postalCode"
        defaultValue={counterparty?.postalCode ?? ""}
      />

      <label htmlFor={idFor("address1")}>{t("cp.address1")}</label>
      <input id={idFor("address1")} name="address1" defaultValue={counterparty?.address1 ?? ""} />

      <label htmlFor={idFor("address2")}>{t("cp.address2")}</label>
      <input id={idFor("address2")} name="address2" defaultValue={counterparty?.address2 ?? ""} />

      <label htmlFor={idFor("department")}>{t("cp.department")}</label>
      <input
        id={idFor("department")}
        name="department"
        defaultValue={counterparty?.department ?? ""}
      />

      {/* 先方のご担当者。**宿泊者の欄ではない**（security.md §3）。 */}
      <label htmlFor={idFor("contactName")}>{t("cp.contactName")}</label>
      <input
        id={idFor("contactName")}
        name="contactName"
        defaultValue={counterparty?.contactName ?? ""}
      />
      <p className="pk-hint">{t("cp.contactName.hint")}</p>

      <label htmlFor={idFor("billingEmail")}>{t("cp.billingEmail")}</label>
      <input
        id={idFor("billingEmail")}
        name="billingEmail"
        type="email"
        defaultValue={counterparty?.billingEmail ?? ""}
        required
      />

      <label htmlFor={idFor("ccEmails")}>{t("cp.ccEmails")}</label>
      <input
        id={idFor("ccEmails")}
        name="ccEmails"
        defaultValue={(counterparty?.ccEmails ?? []).join(", ")}
      />
      <p className="pk-hint">{t("cp.ccEmails.hint")}</p>

      <label htmlFor={idFor("closingDay")}>{t("cp.closingDay")}</label>
      <input
        id={idFor("closingDay")}
        name="closingDay"
        inputMode="numeric"
        defaultValue={String(counterparty?.closingDay ?? 31)}
      />
      <p className="pk-hint">{t("cp.closingDay.hint")}</p>

      <label htmlFor={idFor("paymentTermDays")}>{t("cp.paymentTermDays")}</label>
      <input
        id={idFor("paymentTermDays")}
        name="paymentTermDays"
        inputMode="numeric"
        defaultValue={String(counterparty?.paymentTermDays ?? 30)}
      />

      <label htmlFor={idFor("taxRoundingMode")}>{t("cp.taxRoundingMode")}</label>
      <select
        id={idFor("taxRoundingMode")}
        name="taxRoundingMode"
        defaultValue={counterparty?.taxRoundingMode ?? "FLOOR"}
      >
        <option value="FLOOR">{t("tax.roundingMode.FLOOR")}</option>
        <option value="CEIL">{t("tax.roundingMode.CEIL")}</option>
        <option value="ROUND">{t("tax.roundingMode.ROUND")}</option>
      </select>
      <p className="pk-hint">{t("cp.taxRoundingMode.hint")}</p>
    </>
  );
}

/** 新規登録。**コードはここでしか入力できない**（更新では変えられない）。 */
function CreateForm() {
  return (
    <Form method="post" className="pk-form">
      <input type="hidden" name="intent" value="createCounterparty" />
      <h2>{t("cp.create")}</h2>

      <label htmlFor="new-code">{t("cp.code")}</label>
      <input id="new-code" name="code" pattern="[A-Za-z0-9_-]+" required />
      <p className="pk-hint">{t("cp.code.hint")}</p>

      <CounterpartyFields counterparty={null} />

      <button className="pk-button" type="submit">
        {t("cp.create")}
      </button>
    </Form>
  );
}

/** 編集。**取引を終えるときは「取引中」を外す**（消さない）。 */
function EditForm({ counterparty }: { counterparty: CounterpartySummary }) {
  return (
    <Form method="post" className="pk-form">
      <input type="hidden" name="intent" value="updateCounterparty" />
      <input type="hidden" name="counterpartyId" value={counterparty.counterpartyId} />

      <h2>{t("cp.edit")}</h2>
      <p className="pk-muted">{counterparty.code}</p>

      {counterparty.invoiceRegistrationNo === null ? (
        <p className="pk-notice pk-notice--info">{t("cp.registrationNo.absent")}</p>
      ) : null}

      <CounterpartyFields counterparty={counterparty} />

      <label htmlFor="edit-isActive">{t("cp.active")}</label>
      <input
        id="edit-isActive"
        name="isActive"
        type="checkbox"
        defaultChecked={counterparty.isActive}
      />
      <p className="pk-hint">{t("cp.deactivateNote")}</p>

      <button className="pk-button" type="submit">
        {t("cp.save")}
      </button>
    </Form>
  );
}

/** 料金設定の一覧と追加（§2.2）。**書き換えの口が無い。** */
function PricingSection({
  counterparty,
  rules,
  properties,
  roomTypes,
  canWrite,
}: {
  counterparty: CounterpartySummary;
  rules: readonly PricingRuleSummary[];
  properties: readonly { id: string; name: string }[];
  roomTypes: readonly RoomTypeOption[];
  canWrite: boolean;
}) {
  const propertyName = (id: string | null): string =>
    id === null
      ? t("cp.pricing.any")
      : (properties.find((property) => property.id === id)?.name ?? id);

  const roomTypeName = (id: string | null): string =>
    id === null
      ? t("cp.pricing.any")
      : (roomTypes.find((type) => type.roomTypeId === id)?.roomTypeName ?? id);

  return (
    <section>
      <h2>{t("cp.pricing.title")}</h2>
      <p className="pk-muted">{counterparty.displayName ?? counterparty.legalName}</p>
      <p className="pk-notice">{t("cp.pricing.intro")}</p>

      {rules.length === 0 ? (
        <p className="pk-muted">{t("cp.pricing.empty")}</p>
      ) : (
        <table className="pk-grid">
          <thead>
            <tr>
              <th>{t("cp.pricing.column.item")}</th>
              <th>{t("cp.pricing.column.stage")}</th>
              <th>{t("cp.pricing.column.property")}</th>
              <th>{t("cp.pricing.column.roomType")}</th>
              <th>{t("cp.pricing.column.taskType")}</th>
              <th>{t("cp.pricing.column.unitPrice")}</th>
              <th>{t("cp.pricing.column.taxRate")}</th>
              <th>{t("cp.pricing.column.period")}</th>
              <th>{t("cp.pricing.column.priority")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.pricingRuleId}>
                <th scope="row">{t(ITEM_LABEL[rule.itemCode])}</th>
                {/* 仕様が変わって梯子から外れた古い行を見つけられるようにする。 */}
                <td>
                  {rule.stage === null
                    ? t("cp.pricing.unresolvable")
                    : t(STAGE_LABEL[rule.stage])}
                </td>
                <td>{propertyName(rule.propertyId)}</td>
                <td>{roomTypeName(rule.roomTypeId)}</td>
                <td>
                  {rule.taskType === null
                    ? t("cp.pricing.any")
                    : t(TASK_TYPE_LABEL[rule.taskType as TaskTypeValue])}
                </td>
                <td>{rule.unitPrice}</td>
                <td>
                  {rule.taxRate}
                  {rule.isReducedRate ? ` (${t("cp.pricing.reduced")})` : ""}
                </td>
                <td>
                  {rule.validFrom} – {rule.validTo ?? t("cp.pricing.open")}
                </td>
                <td>{rule.priority}</td>
                <td>
                  {canWrite && rule.validTo === null ? (
                    <Form method="post" className="pk-inline">
                      <input type="hidden" name="intent" value="closePricingRule" />
                      <input type="hidden" name="pricingRuleId" value={rule.pricingRuleId} />
                      <input type="date" name="validTo" required />
                      <button className="pk-button" type="submit">
                        {t("cp.pricing.close")}
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
          <input type="hidden" name="intent" value="createPricingRule" />
          <input type="hidden" name="counterpartyId" value={counterparty.counterpartyId} />

          <h3>{t("cp.pricing.add")}</h3>

          <label htmlFor="itemCode">{t("cp.pricing.column.item")}</label>
          <select id="itemCode" name="itemCode" defaultValue="CLEAN_CHECKOUT">
            {INVOICE_ITEM_CODES.map((code) => (
              <option key={code} value={code}>
                {t(ITEM_LABEL[code])}
              </option>
            ))}
          </select>

          {/* **選ばれない形を組ませない**（冒頭の注記 / DECISIONS #123）。 */}
          <label htmlFor="stage">{t("cp.pricing.scope")}</label>
          <select id="stage" name="stage" defaultValue="3">
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {t(STAGE_LABEL[stage])}
              </option>
            ))}
          </select>
          <p className="pk-hint">{t("cp.pricing.scope.hint")}</p>

          <label htmlFor="propertyRoomTypeId">{t("cp.pricing.roomTypeField")}</label>
          <select id="propertyRoomTypeId" name="propertyRoomTypeId" defaultValue="">
            <option value="">{t("cp.pricing.unset")}</option>
            {roomTypes.map((type) => (
              <option
                key={`${type.propertyId}::${type.roomTypeId}`}
                value={`${type.propertyId}::${type.roomTypeId}`}
              >
                {type.propertyName} / {type.roomTypeName}
              </option>
            ))}
          </select>

          <label htmlFor="propertyId">{t("cp.pricing.column.property")}</label>
          <select id="propertyId" name="propertyId" defaultValue="">
            <option value="">{t("cp.pricing.unset")}</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>

          <label htmlFor="taskType">{t("cp.pricing.column.taskType")}</label>
          <select id="taskType" name="taskType" defaultValue="">
            <option value="">{t("cp.pricing.unset")}</option>
            {TASK_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(TASK_TYPE_LABEL[type])}
              </option>
            ))}
          </select>

          {/* 円（税抜）。**整数だけ**（billing.md §4）。 */}
          <label htmlFor="unitPrice">{t("cp.pricing.column.unitPrice")}</label>
          <input id="unitPrice" name="unitPrice" inputMode="numeric" defaultValue="0" required />

          <label htmlFor="taxRate">{t("cp.pricing.column.taxRate")}</label>
          <select id="taxRate" name="taxRate" defaultValue="10">
            <option value="10">10</option>
            <option value="8">8</option>
          </select>

          <label htmlFor="isReducedRate">{t("cp.pricing.reduced")}</label>
          <input id="isReducedRate" name="isReducedRate" type="checkbox" />

          <label htmlFor="validFrom">{t("cp.pricing.validFrom")}</label>
          <input id="validFrom" name="validFrom" type="date" required />

          <label htmlFor="validTo">{t("cp.pricing.validTo")}</label>
          <input id="validTo" name="validTo" type="date" />

          <label htmlFor="priority">{t("cp.pricing.column.priority")}</label>
          <input id="priority" name="priority" inputMode="numeric" defaultValue="50" />
          <p className="pk-hint">{t("cp.pricing.priorityHint")}</p>

          <button className="pk-button" type="submit">
            {t("cp.pricing.add")}
          </button>
        </Form>
      ) : null}
    </section>
  );
}
