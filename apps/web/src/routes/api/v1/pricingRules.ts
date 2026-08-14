/**
 * 料金設定の API（PK-SPEC-P5 §2.2・§3.2 / P5-03）。
 *
 * ```
 * GET  /api/v1/pricing-rules?counterpartyId=&propertyId=&effectiveOn=
 * POST /api/v1/pricing-rules
 * POST /api/v1/pricing-rules/:pricingRuleId/close
 * ```
 *
 * task:  docs/tasks/P5-03.md
 * ルール: .claude/rules/billing.md §8 / .claude/rules/security.md §1・§6
 *
 * ── 更新の口が無い ──────────────────────────────────────
 * **値上げは行の追加。** 既存の行を書き換えると、過去の請求書の根拠
 * （当時いくらだったか）が変わる。終了は `close`（`validTo` だけを書く）。
 *
 * ── 畳んで返さない ──────────────────────────────────────
 * §3.2 の 5 段階をどれが勝つかは `packages/billing` の純粋関数
 * （`resolvePricing()`）。API は当たりうる行を全部返す。ここで 1 件に
 * 絞ると「該当が無い」と「複数あって選んだ」が画面から区別できない。
 *
 * ── 「今この鍵にいくら付くか」を返す口がある ────────────
 * `GET /resolve` は同じ純粋関数を通した結果を返す。**単価が決まって
 * いなければ `unitPrice` ではなく `resolved: null`。** 0 を返すと
 * 「無料と決めた」と混ざる（§3.2 MUST）。
 */

import {
  pricingRuleCloseRequestSchema,
  pricingRuleCreateRequestSchema,
  type CounterpartyError,
  type PricingRuleCreateResponse,
  type PricingRuleListResponse,
  type PricingRuleSummary,
} from "@pk/contracts";
import { resolvePricing, type PricingRuleFact } from "@pk/billing";
import {
  closePricingRule,
  findCounterpartyById,
  findPricingRuleById,
  insertPricingRule,
  listPricingRules,
  recordAudit,
} from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const pricingRules = new Hono<AppEnv>();

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): CounterpartyError {
  return { error: "INVALID_REQUEST" };
}

/** リポジトリの行を API の形へ。 */
function toSummary(row: {
  id: string;
  counterpartyId: string;
  propertyId: string | null;
  roomTypeId: string | null;
  taskType: string | null;
  itemCode: PricingRuleSummary["itemCode"];
  unitPrice: number;
  taxRate: number;
  isReducedRate: boolean;
  validFrom: string;
  validTo: string | null;
  priority: number;
}): PricingRuleSummary {
  return {
    id: row.id,
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
  };
}

/** 純粋関数へ渡す形。**API の形とほぼ同じだが、依存の向きを固定する。** */
function toFact(row: PricingRuleSummary): PricingRuleFact {
  return {
    id: row.id,
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
  };
}

/** 一覧（§2.2）。**畳まない**（冒頭の注記）。 */
pricingRules.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.read", ORGANIZATION_TARGET);

  const counterpartyId = c.req.query("counterpartyId");
  if (counterpartyId === undefined) return c.json(invalidRequest(), 400);

  // **取引先の実在をここで見る。** 越境 ID は `NotFoundError` → 404。
  const counterparty = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (counterparty === undefined) return c.notFound();

  const propertyId = c.req.query("propertyId");
  const effectiveOn = c.req.query("effectiveOn");
  if (effectiveOn !== undefined && !DATE_PATTERN.test(effectiveOn)) {
    return c.json(invalidRequest(), 400);
  }

  const rows = await listPricingRules(c.env, ctx, {
    counterpartyId,
    ...(propertyId === undefined ? {} : { propertyId }),
    ...(effectiveOn === undefined ? {} : { effectiveOn }),
  });

  const body: PricingRuleListResponse = { data: rows.map(toSummary) };
  return c.json(body);
});

/**
 * この鍵にいまいくら付くか（§3.2 の 5 段階）。
 *
 * **`/:pricingRuleId` より前に置く。** 後ろに置くと `resolve` が ID として
 * 食われる。
 */
pricingRules.get("/resolve", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.read", ORGANIZATION_TARGET);

  const counterpartyId = c.req.query("counterpartyId");
  const propertyId = c.req.query("propertyId");
  const itemCode = c.req.query("itemCode");
  const taskType = c.req.query("taskType");
  const serviceDate = c.req.query("serviceDate");
  // **鍵はすべて分かっている前提**（`PricingKey` の注記）。欠けたまま
  // 引くと「当たらなかった」と「引けなかった」が同じ答えになる。
  if (
    counterpartyId === undefined ||
    propertyId === undefined ||
    itemCode === undefined ||
    taskType === undefined ||
    serviceDate === undefined ||
    !DATE_PATTERN.test(serviceDate)
  ) {
    return c.json(invalidRequest(), 400);
  }

  const counterparty = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (counterparty === undefined) return c.notFound();

  const rows = await listPricingRules(c.env, ctx, { counterpartyId, propertyId });
  const resolved = resolvePricing(rows.map(toSummary).map(toFact), {
    propertyId,
    roomTypeId: c.req.query("roomTypeId") ?? null,
    taskType,
    itemCode,
    serviceDate,
  });

  // **該当が無ければ `null`。** 0 円を返さない（§3.2 MUST）。
  return c.json({
    resolved:
      resolved === null
        ? null
        : { stage: resolved.stage, pricingRuleId: resolved.rule.id, unitPrice: resolved.rule.unitPrice },
  });
});

/** 1 件。 */
pricingRules.get("/:pricingRuleId", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.read", ORGANIZATION_TARGET);

  const row = await findPricingRuleById(c.env, ctx, c.req.param("pricingRuleId"));
  if (row === undefined) return c.notFound();

  const body: PricingRuleCreateResponse = { data: toSummary(row) };
  return c.json(body);
});

/** 追加（§2.2）。**更新ではない。** */
pricingRules.post("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.write", ORGANIZATION_TARGET);

  const parsed = pricingRuleCreateRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const counterparty = await findCounterpartyById(c.env, ctx, parsed.data.counterpartyId);
  if (counterparty === undefined) return c.notFound();

  const id = await insertPricingRule(c.env, ctx, parsed.data);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "pricingRule.created",
    targetType: "pricingRule",
    targetId: id,
    ...(parsed.data.propertyId === null ? {} : { propertyId: parsed.data.propertyId }),
    after: parsed.data,
  });

  const created = await findPricingRuleById(c.env, ctx, id);
  if (created === undefined) return c.notFound();

  const body: PricingRuleCreateResponse = { data: toSummary(created) };
  return c.json(body, 201);
});

/**
 * 期間を閉じる（§2.2）。
 *
 * **単価を送れない。** 送れるのは終了日だけ（contracts の注記）。
 * `validFrom` より前へは閉じられない（400）。
 */
pricingRules.post("/:pricingRuleId/close", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "counterparty.write", ORGANIZATION_TARGET);

  const pricingRuleId = c.req.param("pricingRuleId");
  const before = await findPricingRuleById(c.env, ctx, pricingRuleId);
  if (before === undefined) return c.notFound();

  const parsed = pricingRuleCloseRequestSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const closed = await closePricingRule(c.env, ctx, pricingRuleId, parsed.data.validTo);
  // 開始前に終わる行は作らない（`closePricingRule()` の注記）。
  if (!closed) return c.json(invalidRequest(), 400);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "pricingRule.closed",
    targetType: "pricingRule",
    targetId: pricingRuleId,
    ...(before.propertyId === null ? {} : { propertyId: before.propertyId }),
    before: { validTo: before.validTo },
    after: { validTo: parsed.data.validTo },
  });

  const after = await findPricingRuleById(c.env, ctx, pricingRuleId);
  if (after === undefined) return c.notFound();

  const body: PricingRuleCreateResponse = { data: toSummary(after) };
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

export default pricingRules;
