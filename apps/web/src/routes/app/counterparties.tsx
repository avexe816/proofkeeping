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
 * ── 一覧と、右から出るレイヤー（人間の指示 2026-08-22）─────
 * **スタッフ管理（`staff.tsx`）と同じ組み立てにしてある。** 画面には
 * 一覧のカードだけを置き、登録・編集・終了は行末の「詳細」を押して
 * 出るレイヤーの中で行う。以前は一覧の下に登録フォームと編集フォームが
 * 縦に積まれていて、**どの相手を編集しているのかが画面を下げないと
 * 分からなかった。**
 *
 * 開いているかどうかは URL に持つ（`?panel=`）。選んでいる取引先
 * （`?counterpartyId=`）と同じ扱いで、画面を共有したときに同じものが
 * 開く。**`useState` を使わない** — 中身はサーバーの値で、状態を画面側に
 * 持つと開いた瞬間にもう一度引くことになる。JS が動かなくても開閉する。
 *
 * CSS は `staff.tsx` と同じものをそのまま使う（`.pk-pagehead` /
 * `.pk-panel` / `.pk-tbl` / `.pk-drawer`）。**この画面のためのクラスを
 * 足さないこと。**
 *
 * ── 消すボタンが無い ────────────────────────────────────
 * 取引先は「取引中」を外す（`isActive = false`）。料金は終了日を入れる。
 * どちらも過去の請求書が根拠として指している（CLAUDE.md §4）。
 * **レイヤーの「削除」に当たる操作もこの 2 つ**で、行は消えない。
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
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
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

/**
 * 右からスライドインするレイヤーの中身（`staff.tsx` の `StaffPanel` と同じ形）。
 *
 * `?panel=new` で取引先の登録、`?panel=cp:{id}` で 1 件の編集、
 * `?panel=rule-new` で料金の追加、`?panel=rule:{id}` で 1 件の料金。
 * **前置きを付けてあるのは 2 種類の ID が同じ欄に入るため。**
 */
type CounterpartiesPanel =
  | { mode: "NEW" }
  | { mode: "DETAIL"; counterparty: CounterpartySummary }
  | { mode: "RULE_NEW" }
  | { mode: "RULE"; rule: PricingRuleSummary };

/** 保存の種類。**この 6 つ以外は出さない**（URL から来る値なので絞る）。 */
const SAVED_KINDS = [
  "CREATED",
  "UPDATED",
  "DEACTIVATED",
  "REACTIVATED",
  "RULE_ADDED",
  "RULE_CLOSED",
] as const;

type SavedKind = (typeof SAVED_KINDS)[number];

function parseSaved(value: string | null): SavedKind | null {
  return (SAVED_KINDS as readonly string[]).includes(value ?? "") ? (value as SavedKind) : null;
}

interface CounterpartiesData {
  counterparties: CounterpartySummary[];
  selectedId: string | null;
  pricingRules: PricingRuleSummary[];
  properties: { id: string; name: string }[];
  roomTypes: RoomTypeOption[];
  canWrite: boolean;
  /** レイヤー。閉じているときは `null`。 */
  panel: CounterpartiesPanel | null;
  /** 直前の保存の結果。無ければ `null`。 */
  saved: SavedKind | null;
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
  assertPermission(tenant, "billing.readInternal", ORGANIZATION_TARGET);

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

  const pricingRules =
    selected === null
      ? []
      : (await listPricingRules(env, tenant, { counterpartyId: selected })).map(toRuleSummary);

  const canWrite = can(tenant, "billing.write", ORGANIZATION_TARGET);

  return {
    counterparties: rows,
    selectedId: selected,
    pricingRules,
    properties,
    roomTypes,
    canWrite,
    // **レイヤーは URL で開く。** 引き当てるのは一覧と料金の中からで、
    // ここで DB をもう一度引かない（どちらもすでに手元にある）。
    panel: resolvePanel(new URL(request.url).searchParams.get("panel"), {
      counterparties: rows,
      pricingRules,
      canWrite,
    }),
    // 直前の保存の結果（`savedRedirect()` が付ける）。**リダイレクトを挟むので
    // `useActionData` には残らない。** 知らない値は出さない。
    saved: parseSaved(new URL(request.url).searchParams.get("saved")),
  };
}

/**
 * `?panel=` をレイヤーの中身へ。**知らない値は閉じたまま返す。**
 *
 * **書けない相手には開かない。** 中身は登録・編集・終了の口しか無く、
 * `AUDITOR` に押せないフォームを見せる意味が無い（差し止めは
 * `action` 側の `assertPermission()` が受け持つ / security.md §1）。
 */
function resolvePanel(
  param: string | null,
  data: {
    counterparties: readonly CounterpartySummary[];
    pricingRules: readonly PricingRuleSummary[];
    canWrite: boolean;
  },
): CounterpartiesPanel | null {
  if (param === null || param === "" || !data.canWrite) return null;
  if (param === "new") return { mode: "NEW" };
  if (param === "rule-new") return { mode: "RULE_NEW" };

  if (param.startsWith("cp:")) {
    const id = param.slice("cp:".length);
    const found = data.counterparties.find((row) => row.counterpartyId === id);
    return found === undefined ? null : { mode: "DETAIL", counterparty: found };
  }
  if (param.startsWith("rule:")) {
    const id = param.slice("rule:".length);
    const found = data.pricingRules.find((row) => row.pricingRuleId === id);
    return found === undefined ? null : { mode: "RULE", rule: found };
  }
  return null;
}

/**
 * `action` の戻り値。**成功はここに来ない。**
 *
 * 成功したときはレイヤーを閉じるためにリダイレクトする（`savedRedirect()`）。
 * 残るのは失敗の理由だけで、レイヤーは開いたまま、その中に理由を出す
 * （直すべき欄が目の前にあるのに、説明が幕の下に隠れる形にしない）。
 */
interface CounterpartiesResult {
  duplicateCode?: boolean;
  invalid?: boolean;
}

const CP_PATH = "/app/settings/counterparties";

/**
 * レイヤーの開閉を表す URL。
 *
 * **選んでいる取引先を持ち回る。** 料金の一覧はその相手にぶら下がっており、
 * 落とすと閉じた先で別の相手の料金が並ぶ。
 *
 * @param counterpartyId 選んでいる取引先。`null` で外す。
 * @param panel `null` で閉じる。`"new"` / `"rule-new"` / `"cp:{id}"` / `"rule:{id}"`。
 */
function panelHref(counterpartyId: string | null, panel: string | null): string {
  const params = new URLSearchParams();
  if (counterpartyId !== null) params.set("counterpartyId", counterpartyId);
  if (panel !== null) params.set("panel", panel);
  const query = params.toString();
  return query === "" ? CP_PATH : `${CP_PATH}?${query}`;
}

/**
 * 保存に成功したときの行き先（`staff.tsx` の `savedRedirect()` と同じ作り）。
 *
 * **成功したらレイヤーを閉じる。** `?panel=` を外した URL へ 302 で返す。
 * 画面側で閉じるのではなく**サーバーが行き先を返す**ので、JS が動かなくても
 * 同じように閉じ、戻るボタンで開いたままの状態に戻らない
 * （POST → リダイレクト → GET。二重送信も防ぐ）。
 */
function savedRedirect(counterpartyId: string | null, saved: SavedKind): Response {
  const params = new URLSearchParams();
  if (counterpartyId !== null) params.set("counterpartyId", counterpartyId);
  params.set("saved", saved);
  return redirect(`${CP_PATH}?${params.toString()}`);
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
}: ActionFunctionArgs): Promise<CounterpartiesResult | Response> {
  const env = getEnv(context);
  const now = new Date();
  const { session, tenant } = await requireAppContext(env, request, now);
  assertPermission(tenant, "billing.write", ORGANIZATION_TARGET);

  const form = await request.formData();
  const intent = form.get("intent");
  const actorId = session.membershipId;

  if (intent === "createCounterparty") return createCounterparty(env, tenant, actorId, form);
  if (intent === "updateCounterparty") return editCounterparty(env, tenant, actorId, form);
  // 取引の終了と再開。**編集と同じフォームに混ぜない** —「保存」を押した
  // つもりで取引を終える形にしない（`staff.tsx` の停止・再開と同じ判断）。
  if (intent === "counterpartyActive") return setActive(env, tenant, actorId, form);
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
): Promise<CounterpartiesResult | Response> {
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

  // **作った相手を選んだ状態で閉じる。** 続けて料金を入れる流れになる。
  return savedRedirect(result.id, "CREATED");
}

/** 更新（§2.1）。**`code` は送らない**（contracts が持たない）。 */
async function editCounterparty(
  env: Env,
  tenant: Tenant,
  actorId: string,
  form: FormData,
): Promise<CounterpartiesResult | Response> {
  const counterpartyId = orUndefined(form.get("counterpartyId"));
  if (counterpartyId === undefined) return { invalid: true };

  // **「取引中」はここで触らない。** 取引の終了・再開は `counterpartyActive`
  // が受け持つ（`action` の注記）。混ぜると、住所を直したつもりで
  // チェックが外れていて取引が終わる、という取り違えが起こる。
  const parsed = counterpartyUpdateSchema.safeParse(counterpartyFields(form));
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

  return savedRedirect(counterpartyId, "UPDATED");
}

/**
 * 取引の終了と再開（§2.1）。**行は消さない**（CLAUDE.md §4）。
 *
 * 終えた相手は一覧に残り、灰色で表示される。過去の請求書がこの相手を
 * 指しているため、消すと帳票の宛先が誰か分からなくなる。**戻せる。**
 */
async function setActive(
  env: Env,
  tenant: Tenant,
  actorId: string,
  form: FormData,
): Promise<CounterpartiesResult | Response> {
  const counterpartyId = orUndefined(form.get("counterpartyId"));
  if (counterpartyId === undefined) return { invalid: true };

  // **既定を「終える」にしない。** 値が落ちたときに取引が止まる側へ
  // 倒れる形にしないため、`"true"` のときだけ再開する。
  const isActive = form.get("isActive") === "true";

  const before = await findCounterpartyById(env, tenant, counterpartyId);
  if (before === undefined) throw new NotFoundError();

  await updateCounterparty(env, tenant, counterpartyId, { isActive });

  await recordAudit(env, tenant, {
    actorId,
    action: "counterparty.updated",
    targetType: "counterparty",
    targetId: counterpartyId,
    before: auditPayload(before),
    after: auditPayload({ ...before, isActive }),
  });

  return savedRedirect(counterpartyId, isActive ? "REACTIVATED" : "DEACTIVATED");
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
): Promise<CounterpartiesResult | Response> {
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

  return savedRedirect(counterpartyId, "RULE_ADDED");
}

/** 期間を閉じる（§2.2）。**`validTo` だけ。** */
async function closeRule(
  env: Env,
  tenant: Tenant,
  actorId: string,
  form: FormData,
): Promise<CounterpartiesResult | Response> {
  const pricingRuleId = orUndefined(form.get("pricingRuleId"));
  if (pricingRuleId === undefined) return { invalid: true };
  // 閉じたあとに戻る先。**料金は取引先にぶら下がっている**ので、
  // 落とすと別の相手の料金が並んだ画面へ帰ることになる。
  const counterpartyId = orUndefined(form.get("counterpartyId")) ?? null;

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

  return savedRedirect(counterpartyId, "RULE_CLOSED");
}

/**
 * 直前の保存が失敗した理由 → 文言のキー。**成功はここに来ない**
 * （成功はリダイレクトになるので `useActionData` に残らない）。
 */
function drawerErrorKey(result: CounterpartiesResult | undefined): MessageKey | null {
  if (result === undefined) return null;
  if (result.duplicateCode === true) return "cp.duplicateCode";
  if (result.invalid === true) return "cp.invalid";
  return null;
}

/**
 * 右からスライドインするレイヤー（`staff.tsx` の `StaffDrawer` と同じもの）。
 *
 * ── 素の HTML で開いて閉じる ────────────────────────────
 * 中身はサーバーが描き、閉じるのはリンク 1 本。**JS が動かなくても
 * 開閉する。** 動き（スライドイン）は CSS の `@keyframes` で、
 * `prefers-reduced-motion` を立てている人には出さない（`app.css`）。
 *
 * ── 背景の暗幕もリンク ──────────────────────────────────
 * 幕の外を押すと閉じる、という当たり前の動きを `onClick` ではなく
 * `<Link>` で作る。**キーボードでも到達できる**（`onClick` を載せた
 * `<div>` には Tab で行けない）。
 *
 * ── 閉じるは左端 ────────────────────────────────────────
 * 右上に置くとトップバーのログアウトの真下に来る。閉じると × ごと
 * 消えるので、勢いで 2 回押すと 2 回目がログアウトに当たる
 * （`staff.tsx` の注記と同じ理由）。
 */
function CpDrawer({
  title,
  closeHref,
  error,
  children,
}: {
  title: string;
  closeHref: string;
  /** 直前の保存が失敗した理由。**レイヤーの中に出す**（下の注記）。 */
  error: MessageKey | null;
  children: React.ReactNode;
}) {
  // 開くのも保存もサーバーへの往復なので、押してから戻るまでに間がある。
  // **その間ポインタを「処理中」にし、送信ボタンを押せなくする。**
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <div className={busy ? "pk-drawer pk-drawer--busy" : "pk-drawer"} aria-busy={busy}>
      <Link className="pk-drawer__scrim" to={closeHref} aria-label={t("cp.panel.close")} />
      <aside className="pk-drawer__panel" aria-label={title}>
        <div className="pk-drawer__head">
          {/* **文字ではなく図形で描く。** `×` は字面の位置がフォントごとに
              違い、見出しとの上下が環境によってずれる。 */}
          <Link className="pk-drawer__close" to={closeHref} aria-label={t("cp.panel.close")}>
            <svg
              className="pk-drawer__closeIcon"
              viewBox="0 0 12 12"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5" />
            </svg>
          </Link>
          <h2 className="pk-drawer__title">{title}</h2>
        </div>
        <div className="pk-drawer__body">
          {/* **失敗の理由はレイヤーの中に出す。** 画面の側に出すと、
              直すべき欄が目の前にあるのに、その説明が幕の下に隠れる。 */}
          {error === null ? null : <p className="pk-notice pk-notice--warn">{t(error)}</p>}
          {children}
        </div>
      </aside>
    </div>
  );
}

/**
 * レイヤーの中の送信ボタン。**送信中は押せなくする。**
 *
 * 往復の間にもう一度押せると、同じ保存が 2 度飛ぶ。ポインタの形は
 * `.pk-drawer--busy` が受け持つ。
 */
function SubmitButton({ label }: { label: string }) {
  const navigation = useNavigation();

  return (
    <button type="submit" disabled={navigation.state !== "idle"}>
      {label}
    </button>
  );
}

/** レイヤーの見出し。 */
function panelTitle(panel: CounterpartiesPanel): string {
  if (panel.mode === "NEW") return t("cp.panel.newTitle");
  if (panel.mode === "RULE_NEW") return t("cp.pricing.panel.newTitle");
  if (panel.mode === "RULE") return t(ITEM_LABEL[panel.rule.itemCode]);
  return panel.counterparty.displayName ?? panel.counterparty.legalName;
}

export default function Counterparties() {
  const data = useLoaderData<CounterpartiesData>();
  const result = useActionData<CounterpartiesResult>();
  const selected =
    data.counterparties.find((row) => row.counterpartyId === data.selectedId) ?? null;

  return (
    <section className="pk-page">
      <div className="pk-pagehead">
        <h1 className="pk-pagehead__title">{t("cp.title")}</h1>
        {data.canWrite ? (
          <div className="pk-pagehead__actions">
            {/* 料金は取引先にぶら下がるので、相手を選んでいるときだけ出す。 */}
            {selected === null ? null : (
              <Link className="pk-button" to={panelHref(data.selectedId, "rule-new")}>
                {t("cp.pricing.add")}
              </Link>
            )}
            <Link className="pk-button pk-button--primary" to={panelHref(data.selectedId, "new")}>
              {t("cp.create")}
            </Link>
          </div>
        ) : null}
      </div>
      <p className="pk-page__lede">{t("cp.intro")}</p>

      {/* **成功の知らせは画面の側に出す。** レイヤーはもう閉じている
          （`savedRedirect()`）。理由は `?saved=` で運ばれてくる。 */}
      {data.saved === null ? null : (
        <p className="pk-message">{t(`cp.saved.${data.saved}` as MessageKey)}</p>
      )}

      <CounterpartyList
        counterparties={data.counterparties}
        selectedId={data.selectedId}
        canWrite={data.canWrite}
      />

      {data.canWrite ? null : <p className="pk-muted">{t("cp.readOnly")}</p>}

      {selected === null ? null : (
        <PricingSection
          counterparty={selected}
          rules={data.pricingRules}
          properties={data.properties}
          roomTypes={data.roomTypes}
          canWrite={data.canWrite}
        />
      )}

      {data.panel === null ? null : (
        <CpDrawer
          title={panelTitle(data.panel)}
          closeHref={panelHref(data.selectedId, null)}
          error={drawerErrorKey(result)}
        >
          <PanelBody
            panel={data.panel}
            selected={selected}
            properties={data.properties}
            roomTypes={data.roomTypes}
          />
        </CpDrawer>
      )}
    </section>
  );
}

/** レイヤーの中身の振り分け。**4 つのうち 1 つだけが出る。** */
function PanelBody({
  panel,
  selected,
  properties,
  roomTypes,
}: {
  panel: CounterpartiesPanel;
  selected: CounterpartySummary | null;
  properties: readonly { id: string; name: string }[];
  roomTypes: readonly RoomTypeOption[];
}) {
  if (panel.mode === "NEW") return <CreateForm />;
  if (panel.mode === "DETAIL") return <EditForm counterparty={panel.counterparty} />;
  if (panel.mode === "RULE") {
    return <RulePanel rule={panel.rule} properties={properties} roomTypes={roomTypes} />;
  }
  // 料金の追加。**相手が決まっていないと組めない**（`counterpartyId` が要る）。
  return selected === null ? (
    <p className="pk-notice">{t("cp.pricing.selectFirst")}</p>
  ) : (
    <PricingCreateForm counterparty={selected} properties={properties} roomTypes={roomTypes} />
  );
}

/**
 * 取引先の一覧（プロトタイプ ops 07 の「スタッフ一覧」と同じ組み立て）。
 *
 * ── 行末の「詳細」でレイヤーを開く ──────────────────────
 * 名称を押すとその相手の料金に切り替わり、「詳細」を押すと編集の
 * レイヤーが出る。**2 つを 1 つのリンクに束ねない** — 料金を見たいだけの
 * ときに編集の口が開くのは、押し間違いが編集に化ける形になる。
 */
function CounterpartyList({
  counterparties,
  selectedId,
  canWrite,
}: {
  counterparties: readonly CounterpartySummary[];
  selectedId: string | null;
  canWrite: boolean;
}) {
  return (
    <section className="pk-panel">
      <div className="pk-panel__head">
        <span className="pk-panel__icon" aria-hidden="true">
          🏢
        </span>
        {t("cp.list.card")}
        <span className="pk-panel__note">{t("cp.list.selectHint")}</span>
      </div>
      {counterparties.length === 0 ? (
        <div className="pk-panel__body">
          <p className="pk-muted">{t("cp.empty")}</p>
        </div>
      ) : (
        <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
          <table className="pk-tbl">
            <thead>
              <tr>
                <th>{t("cp.column.code")}</th>
                <th>{t("cp.column.name")}</th>
                <th>{t("cp.column.registrationNo")}</th>
                <th>{t("cp.column.closing")}</th>
                <th>{t("cp.column.payment")}</th>
                <th>{t("cp.column.rounding")}</th>
                <th>{t("cp.column.status")}</th>
                {/* 「詳細」の列。**見出しを空にしない** — 読み上げで
                    列の意味が消える（表の他の列と同じ扱いにする）。 */}
                {canWrite ? <th>{t("cp.column.detail")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {counterparties.map((row) => (
                <tr key={row.counterpartyId} className={row.isActive ? undefined : "pk-row--muted"}>
                  <th scope="row">
                    {/* 相手を選ぶ。**レイヤーは開かない**（上の注記）。 */}
                    <Link to={panelHref(row.counterpartyId, null)}>{row.code}</Link>
                  </th>
                  <td>{row.displayName ?? row.legalName}</td>
                  <td>{row.invoiceRegistrationNo ?? t("cp.registrationNo.none")}</td>
                  <td>{row.closingDay}</td>
                  <td>{row.paymentTermDays}</td>
                  <td>{t(ROUNDING_LABEL[row.taxRoundingMode])}</td>
                  <td>
                    <span className={row.isActive ? "pk-tag pk-tag--ok" : "pk-tag pk-tag--muted"}>
                      {row.isActive ? t("cp.active") : t("cp.inactive")}
                    </span>
                  </td>
                  {canWrite ? (
                    <td>
                      {/* **`<Link>` にしてある** — 素の `<a>` だと画面ごと
                          読み直しになり、レイヤーが出てくる動きが消える。
                          開いても選んでいる相手は変えない（`selectedId`）。 */}
                      <Link
                        className="pk-button"
                        to={panelHref(selectedId, `cp:${row.counterpartyId}`)}
                      >
                        {t("cp.detail")}
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** 取引先の共通の入力欄。**作成と更新で同じ並び。** */
function CounterpartyFields({ counterparty }: { counterparty: CounterpartySummary | null }) {
  const idFor = (name: string): string => (counterparty === null ? `new-${name}` : `edit-${name}`);

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

/** 新規登録（レイヤーの中）。**コードはここでしか入力できない**（更新では変えられない）。 */
function CreateForm() {
  return (
    <Form method="post" className="pk-form">
      <input type="hidden" name="intent" value="createCounterparty" />

      <label htmlFor="new-code">{t("cp.code")}</label>
      <input id="new-code" name="code" pattern="[A-Za-z0-9_-]+" required />
      <p className="pk-hint">{t("cp.code.hint")}</p>

      <CounterpartyFields counterparty={null} />

      <SubmitButton label={t("cp.create")} />
    </Form>
  );
}

/**
 * 編集（レイヤーの中）。
 *
 * ── 「削除」ではなく「取引を終える」──────────────────────
 * 行は消えない（CLAUDE.md §4）。発行済みの請求書がこの相手を宛先として
 * 指しているため、消すと帳票の宛先が誰か分からなくなる。終えるとこの
 * 相手は請求の対象から外れ、一覧では灰色になる。**戻せる。**
 */
function EditForm({ counterparty }: { counterparty: CounterpartySummary }) {
  return (
    <>
      <dl className="pk-drawer__facts">
        <dt>{t("cp.code")}</dt>
        <dd>{counterparty.code}</dd>
        <dt>{t("cp.column.status")}</dt>
        <dd>
          <span className={counterparty.isActive ? "pk-tag pk-tag--ok" : "pk-tag pk-tag--muted"}>
            {t(counterparty.isActive ? "cp.active" : "cp.inactive")}
          </span>
        </dd>
      </dl>

      {counterparty.invoiceRegistrationNo === null ? (
        <p className="pk-notice pk-notice--info">{t("cp.registrationNo.absent")}</p>
      ) : null}

      <h3 className="pk-drawer__section">{t("cp.panel.section.profile")}</h3>
      <Form method="post" className="pk-form">
        <input type="hidden" name="intent" value="updateCounterparty" />
        <input type="hidden" name="counterpartyId" value={counterparty.counterpartyId} />

        <CounterpartyFields counterparty={counterparty} />

        <SubmitButton label={t("cp.save")} />
      </Form>

      {/* 取引の終了と再開。**編集と同じフォームに混ぜない** —「保存」を
          押したつもりで取引を終えることになる（`action` の注記）。 */}
      <h3 className="pk-drawer__section pk-drawer__section--danger">
        {t("cp.panel.section.status")}
      </h3>
      <Form method="post" className="pk-form pk-drawer__danger">
        <input type="hidden" name="intent" value="counterpartyActive" />
        <input type="hidden" name="counterpartyId" value={counterparty.counterpartyId} />
        <input type="hidden" name="isActive" value={counterparty.isActive ? "false" : "true"} />
        <p className="pk-form__note">
          {t(counterparty.isActive ? "cp.deactivateNote" : "cp.panel.reactivateNote")}
        </p>
        <SubmitButton
          label={t(counterparty.isActive ? "cp.panel.deactivate" : "cp.panel.reactivate")}
        />
      </Form>
    </>
  );
}

/** 施設名 / 客室タイプ名の引き当て。**見つからない ID は素のまま出す。** */
function useNames(
  properties: readonly { id: string; name: string }[],
  roomTypes: readonly RoomTypeOption[],
): {
  propertyName: (id: string | null) => string;
  roomTypeName: (id: string | null) => string;
} {
  return {
    propertyName: (id) =>
      id === null
        ? t("cp.pricing.any")
        : (properties.find((property) => property.id === id)?.name ?? id),
    roomTypeName: (id) =>
      id === null
        ? t("cp.pricing.any")
        : (roomTypes.find((type) => type.roomTypeId === id)?.roomTypeName ?? id),
  };
}

/**
 * 料金設定の一覧（§2.2）。**書き換えの口が無い。**
 *
 * 取引先の一覧と同じ組み立てにしてある。行末の「詳細」でレイヤーが出て、
 * その中で終了日を入れる。追加は見出しの帯のボタンから。
 */
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
  const { propertyName, roomTypeName } = useNames(properties, roomTypes);

  return (
    <section className="pk-panel">
      <div className="pk-panel__head">
        <span className="pk-panel__icon" aria-hidden="true">
          💴
        </span>
        {t("cp.pricing.title")}
        {/* **どの相手の値段かを見出しに出す。** 一覧を選び直すと変わる。 */}
        <span className="pk-panel__note">{counterparty.displayName ?? counterparty.legalName}</span>
      </div>
      {rules.length === 0 ? (
        <div className="pk-panel__body">
          <p className="pk-muted">{t("cp.pricing.empty")}</p>
        </div>
      ) : (
        <div className="pk-panel__body pk-panel__body--flush pk-scroll-x">
          <table className="pk-tbl">
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
                {canWrite ? <th>{t("cp.column.detail")}</th> : null}
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
                  <td className="pk-num">{rule.unitPrice}</td>
                  <td>
                    {rule.taxRate}
                    {rule.isReducedRate ? ` (${t("cp.pricing.reduced")})` : ""}
                  </td>
                  <td>
                    {rule.validFrom} – {rule.validTo ?? t("cp.pricing.open")}
                  </td>
                  <td className="pk-num">{rule.priority}</td>
                  {canWrite ? (
                    <td>
                      <Link
                        className="pk-button"
                        to={panelHref(counterparty.counterpartyId, `rule:${rule.pricingRuleId}`)}
                      >
                        {t("cp.detail")}
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pk-panel__foot">{t("cp.pricing.intro")}</div>
    </section>
  );
}

/**
 * 料金 1 件の詳細（レイヤーの中）。
 *
 * ── 直す欄が無いのは意図 ────────────────────────────────
 * 単価を書き換えると、その料金で出した過去の請求書の根拠が消える
 * （billing.md §6 / §2.2）。**変えるときは終了日を入れて、新しい行を
 * 足す。** これが「編集」に当たる操作で、行の書き換えではない。
 *
 * ── 「削除」に当たるのは終了日 ──────────────────────────
 * 行は消えない。終了日を過ぎたタスクにこの料金が使われなくなるだけで、
 * それ以前の請求書は同じ根拠を指したまま残る。
 */
function RulePanel({
  rule,
  properties,
  roomTypes,
}: {
  rule: PricingRuleSummary;
  properties: readonly { id: string; name: string }[];
  roomTypes: readonly RoomTypeOption[];
}) {
  const { propertyName, roomTypeName } = useNames(properties, roomTypes);

  return (
    <>
      <dl className="pk-drawer__facts">
        <dt>{t("cp.pricing.column.stage")}</dt>
        <dd>{rule.stage === null ? t("cp.pricing.unresolvable") : t(STAGE_LABEL[rule.stage])}</dd>
        <dt>{t("cp.pricing.column.property")}</dt>
        <dd>{propertyName(rule.propertyId)}</dd>
        <dt>{t("cp.pricing.column.roomType")}</dt>
        <dd>{roomTypeName(rule.roomTypeId)}</dd>
        <dt>{t("cp.pricing.column.taskType")}</dt>
        <dd>
          {rule.taskType === null
            ? t("cp.pricing.any")
            : t(TASK_TYPE_LABEL[rule.taskType as TaskTypeValue])}
        </dd>
        <dt>{t("cp.pricing.column.unitPrice")}</dt>
        <dd>{rule.unitPrice}</dd>
        <dt>{t("cp.pricing.column.taxRate")}</dt>
        <dd>
          {rule.taxRate}
          {rule.isReducedRate ? ` (${t("cp.pricing.reduced")})` : ""}
        </dd>
        <dt>{t("cp.pricing.column.period")}</dt>
        <dd>
          {rule.validFrom} – {rule.validTo ?? t("cp.pricing.open")}
        </dd>
        <dt>{t("cp.pricing.column.priority")}</dt>
        <dd>{rule.priority}</dd>
      </dl>

      <p className="pk-notice">{t("cp.pricing.immutable")}</p>

      <h3 className="pk-drawer__section pk-drawer__section--danger">
        {t("cp.pricing.panel.section.close")}
      </h3>
      {rule.validTo === null ? (
        <Form method="post" className="pk-form pk-drawer__danger">
          <input type="hidden" name="intent" value="closePricingRule" />
          <input type="hidden" name="pricingRuleId" value={rule.pricingRuleId} />
          <input type="hidden" name="counterpartyId" value={rule.counterpartyId} />

          <label htmlFor="close-validTo">{t("cp.pricing.validTo")}</label>
          <input id="close-validTo" name="validTo" type="date" required />
          <p className="pk-form__note">{t("cp.pricing.closeNote")}</p>

          <SubmitButton label={t("cp.pricing.close")} />
        </Form>
      ) : (
        <p className="pk-notice">{t("cp.pricing.alreadyClosed")}</p>
      )}
    </>
  );
}

/** 料金の追加（レイヤーの中 / §2.2）。 */
function PricingCreateForm({
  counterparty,
  properties,
  roomTypes,
}: {
  counterparty: CounterpartySummary;
  properties: readonly { id: string; name: string }[];
  roomTypes: readonly RoomTypeOption[];
}) {
  return (
    <Form method="post" className="pk-form">
      <input type="hidden" name="intent" value="createPricingRule" />
      <input type="hidden" name="counterpartyId" value={counterparty.counterpartyId} />

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

      <label className="pk-form__check" htmlFor="isReducedRate">
        <input id="isReducedRate" name="isReducedRate" type="checkbox" />
        {t("cp.pricing.reduced")}
      </label>

      <label htmlFor="validFrom">{t("cp.pricing.validFrom")}</label>
      <input id="validFrom" name="validFrom" type="date" required />

      <label htmlFor="validTo">{t("cp.pricing.validTo")}</label>
      <input id="validTo" name="validTo" type="date" />

      <label htmlFor="priority">{t("cp.pricing.column.priority")}</label>
      <input id="priority" name="priority" inputMode="numeric" defaultValue="50" />
      <p className="pk-hint">{t("cp.pricing.priorityHint")}</p>

      <SubmitButton label={t("cp.pricing.add")} />
    </Form>
  );
}
