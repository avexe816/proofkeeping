/**
 * 取引先マスタの API（PK-SPEC-P5 §2.1 / P5-02）。
 *
 * ```
 * GET   /api/v1/counterparties?isActive=true
 * POST  /api/v1/counterparties
 * PATCH /api/v1/counterparties/:counterpartyId
 * ```
 *
 * task:  docs/tasks/P5-02.md
 * ルール: .claude/rules/security.md §1・§6 / .claude/rules/billing.md §1・§6
 *
 * ── 消す口が無い ────────────────────────────────────────
 * 取引を終えた相手は `isActive = false`。過去の請求書が `counterpartyId` で
 * 参照しており、行を消すと帳票から相手が辿れなくなる。
 *
 * ── 書けるのは組織全体ロールだけ ────────────────────────
 * `counterparty.write` は `OWNER` / `ORG_ADMIN`。取引先は組織のマスタで、
 * 1 施設の責任者が締め日や請求先メールを動かせる形にしない
 * （動かした結果は組織のすべての請求書に効く）。読みは `billing.read` と
 * 同じ配り方（`INSPECTOR` / `CLEANER` は 404 / security.md §1）。
 *
 * ── 登録番号の実在は確かめられない ──────────────────────
 * `T` + 13 桁の**形式だけ**を見る（billing.md §1）。国税庁への照会は
 * ここからは行けない。未設定でも請求書は出せる（適格請求書ではない旨を
 * 帳票に明記する / §8.1）。
 *
 * ── `code` の重複は 409 ─────────────────────────────────
 * `uq_cp`（組織 × コード）。リポジトリの `upsertCounterparty()` は
 * コード一致で更新に落ちるが、**POST は「作る」意図**なので、
 * 既存に当たったら黙って上書きせず 409 を返す。
 */

import {
  counterpartyUpsertRequestSchema,
  type CounterpartyError,
  type CounterpartyListResponse,
  type CounterpartySummary,
  type CounterpartyUpsertResponse,
} from "@pk/contracts";
import {
  findCounterpartyById,
  listCounterparties,
  recordAudit,
  upsertCounterparty,
} from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const counterparties = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): CounterpartyError {
  return { error: "INVALID_REQUEST" };
}

/** リポジトリの行を API の形へ。**`isQualifiedIssuer` はここで導く。** */
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
    id: row.id,
    code: row.code,
    legalName: row.legalName,
    displayName: row.displayName,
    invoiceRegistrationNo: row.invoiceRegistrationNo,
    // 画面に判定を持たせない（登録番号があれば適格請求書を出せる / billing.md §1）。
    isQualifiedIssuer: row.invoiceRegistrationNo !== null,
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

/** 一覧（§2.1）。`isActive=true` で稼働中だけに絞る。 */
counterparties.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.read", ORGANIZATION_TARGET);

  const isActiveRaw = c.req.query("isActive");
  if (isActiveRaw !== undefined && isActiveRaw !== "true" && isActiveRaw !== "false") {
    return c.json(invalidRequest(), 400);
  }

  const rows = await listCounterparties(c.env, ctx, {
    ...(isActiveRaw === undefined ? {} : { isActive: isActiveRaw === "true" }),
  });

  const body: CounterpartyListResponse = { data: rows.map(toSummary) };
  return c.json(body);
});

/** 1 件。**越境 ID は `NotFoundError` → 404**（403 を返さない）。 */
counterparties.get("/:counterpartyId", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.read", ORGANIZATION_TARGET);

  const row = await findCounterpartyById(c.env, ctx, c.req.param("counterpartyId"));
  if (row === undefined) return c.notFound();

  const body: CounterpartyUpsertResponse = { data: toSummary(row) };
  return c.json(body);
});

/** 新規登録（§2.1）。**既存コードに当たったら 409。** */
counterparties.post("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.write", ORGANIZATION_TARGET);

  const parsed = counterpartyUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  // **上書きにならないよう先に見る。** `upsertCounterparty()` はコード一致で
  // 更新へ落ちるので、POST の意図（作る）と結果がずれる。
  const existing = await listCounterparties(c.env, ctx, {});
  if (existing.some((row) => row.code === parsed.data.code)) {
    const conflict: CounterpartyError = { error: "DUPLICATE_CODE" };
    return c.json(conflict, 409);
  }

  const { id } = await upsertCounterparty(c.env, ctx, parsed.data);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "counterparty.created",
    targetType: "counterparty",
    targetId: id,
    after: parsed.data,
  });

  const created = await findCounterpartyById(c.env, ctx, id);
  if (created === undefined) return c.notFound();

  const body: CounterpartyUpsertResponse = { data: toSummary(created) };
  return c.json(body, 201);
});

/**
 * 更新（§2.1）。
 *
 * **全項目を送る形にしてある**（部分更新にしない）。締め日と支払サイトは
 * 対になって請求のタイミングを決めるので、片方だけ届いたときの解釈を
 * 画面と API で二重に持たない。監査ログの `before` / `after` も揃う。
 */
counterparties.patch("/:counterpartyId", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.write", ORGANIZATION_TARGET);

  const counterpartyId = c.req.param("counterpartyId");
  const before = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (before === undefined) return c.notFound();

  const parsed = counterpartyUpsertRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  // **コードは付け替えられない。** `upsertCounterparty()` が引くのは
  // `uq_cp`（組織 × コード）で、別のコードを送ると「更新」ではなく
  // **もう 1 件が生まれる。** 取引先コードは請求書の突合に使われる値でも
  // あり、途中で変わると先方の会計側で別の相手に見える。
  // 付け替えたいときは新しい相手を作り、古い方を `isActive = false` にする。
  if (parsed.data.code !== before.code) return c.json(invalidRequest(), 400);

  await upsertCounterparty(c.env, ctx, parsed.data);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "counterparty.updated",
    targetType: "counterparty",
    targetId: counterpartyId,
    before: toSummary(before),
    after: parsed.data,
  });

  const after = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (after === undefined) return c.notFound();

  const body: CounterpartyUpsertResponse = { data: toSummary(after) };
  return c.json(body);
});

/** JSON を読む。**壊れていたら `null`。** 例外を 500 にしない。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default counterparties;
