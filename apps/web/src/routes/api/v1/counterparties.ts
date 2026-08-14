/**
 * 取引先マスタの API（PK-SPEC-P5 §2.1・§9）。
 *
 * ```
 * GET   /api/v1/counterparties?isActive=
 * POST  /api/v1/counterparties
 * PATCH /api/v1/counterparties/:counterpartyId
 * ```
 *
 * task: docs/tasks/P5-02.md
 *
 * ── 物理削除の口が無い ──────────────────────────────────
 * CLAUDE.md §4。取引を終えた相手は `PATCH { isActive: false }`。
 * **`DELETE` を足さないこと。** 料金設定・月次締め・過去の請求書が
 * この ID を参照している。
 *
 * ── 施設スコープを掛けない ──────────────────────────────
 * 取引先は組織のマスタで `propertyId` を持たない。到達してよいかは
 * `billing.read` / `billing.write`（どちらも組織単位）で決まる。
 *
 * ── Idempotency-Key ─────────────────────────────────────
 * ヘッダは受けるが、鍵の記録という別の状態を作らない。`POST` は
 * `uq_cp`（組織 × コード）で 2 回目が 409 になり、`PATCH` は渡された
 * 項目をその値にするだけで何度送っても同じ状態になる。採番も課金も
 * 伴わないため `roomTypes.ts` と同じ判断（docs/DECISIONS.md #055）。
 */

import {
  counterpartyCreateSchema,
  counterpartyUpdateSchema,
  type CounterpartyListResponse,
  type CounterpartySummary,
} from "@pk/contracts";
import {
  findCounterpartyById,
  listCounterparties,
  recordAudit,
  updateCounterparty,
  upsertCounterparty,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, ORGANIZATION_TARGET } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const counterparties = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 一覧。**既定は無効化済みも返す**（設定を編む画面が取り消せるように）。 */
counterparties.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const isActiveParam = c.req.query("isActive");
  if (isActiveParam !== undefined && isActiveParam !== "true" && isActiveParam !== "false") {
    return c.json(invalidRequest(), 400);
  }

  const rows = await listCounterparties(c.env, ctx, {
    ...(isActiveParam === undefined ? {} : { isActive: isActiveParam === "true" }),
  });

  const body: CounterpartyListResponse = { data: rows.map(toSummary) };
  return c.json(body);
});

/**
 * 作成。**コードが既存とぶつかったら 409。**
 *
 * `upsertCounterparty()` はコードが一致すると更新に落ちるので、
 * 先に引いてから呼ぶ。黙って上書きすると「新しい取引先を作ったつもりが
 * 既存の請求先メールを書き換えていた」という壊れ方をする。
 */
counterparties.post("/", async (c) => {
  const parsed = counterpartyCreateSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const existing = await listCounterparties(c.env, ctx);
  if (existing.some((row) => row.code === parsed.data.code)) {
    return c.json({ error: "DUPLICATE_CODE" as const }, 409);
  }

  const input = parsed.data;
  const result = await upsertCounterparty(c.env, ctx, {
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

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "counterparty.created",
    targetType: "counterparty",
    targetId: result.id,
    after: auditPayload(input),
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ counterpartyId: result.id }, 201);
});

/** 更新・無効化。**越境 ID は `findCounterpartyById()` が 404 にする。** */
counterparties.patch("/:counterpartyId", async (c) => {
  const parsed = counterpartyUpdateSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const counterpartyId = c.req.param("counterpartyId");
  const before = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (before === undefined) return c.json({ error: "RESOURCE_NOT_FOUND" as const }, 404);

  await updateCounterparty(c.env, ctx, counterpartyId, parsed.data);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "counterparty.updated",
    targetType: "counterparty",
    targetId: counterpartyId,
    before: auditPayload(before),
    after: parsed.data,
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ counterpartyId });
});

/**
 * 監査ログに残す項目。
 *
 * **住所・担当者名を含めない。** 取引先の担当者は個人で、変更のたびに
 * 監査ログへ写すと、消せない表に個人の情報が溜まる（security.md §6 は
 * 「`before` / `after` にパスワードハッシュ・PIN ハッシュを含めない」と
 * しか書いていないが、必要のない個人の情報を積む理由も無い）。
 * 金額と送付先に効く項目だけを残す。
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

/** 一覧の 1 件。**`organizationId` を落とす。** */
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

function ipOf(ip: string | undefined): { ip?: string } {
  return ip === undefined ? {} : { ip };
}

export default counterparties;
