/**
 * 料金設定の API（PK-SPEC-P5 §2.2・§3.2・§9）。
 *
 * ```
 * GET   /api/v1/pricing-rules?counterpartyId=&propertyId=&effectiveOn=
 * POST  /api/v1/pricing-rules
 * PATCH /api/v1/pricing-rules/:pricingRuleId   ← 期間を閉じるだけ
 * ```
 *
 * task: docs/tasks/P5-03.md
 * ルール: .claude/rules/billing.md §8
 *
 * ── 更新でも削除でもなく「期間を閉じる」──────────────
 * `PATCH` が受けるのは `validTo` だけ。値上げは行の追加で表す（§2.2）。
 * 単価を書き換えられると、過去の請求書の根拠（当時いくらだったか）が
 * 変わる。**単価・対象・税率を受ける口を足さないこと。**
 *
 * ── 梯子に載らない形は 400 で断る ──────────────────────
 * §3.2 の 5 段はすべて「客室タイプを見るなら作業種別も見る」形で、
 * たとえば 施設 + 客室タイプ（作業種別なし）に当たる段が無い。
 * 登録できても永遠に選ばれないので、その形をここで断る。
 * 判定は `packages/billing` の `pricingRuleStage()`（docs/DECISIONS.md #123）。
 */

import {
  pricingRuleCloseSchema,
  pricingRuleCreateSchema,
  type PricingRuleListResponse,
  type PricingRuleSummary,
} from "@pk/contracts";
import { pricingRuleStage } from "@pk/billing";
import {
  closePricingRule,
  findCounterpartyById,
  findPricingRuleById,
  insertPricingRule,
  listPricingRules,
  recordAudit,
} from "@pk/db";
import { Hono } from "hono";

import { assertPermission, ORGANIZATION_TARGET } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const pricingRules = new Hono<AppEnv>();

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

/**
 * 一覧。**畳まない。**
 *
 * どの行が勝つか（§3.2）は `stage` を添えて画面に判断させる。ここで
 * 1 件に絞ると、「該当が無い」のか「複数あって選んだ」のかが読めなくなる
 * （`listPricingRules()` の注記）。
 */
pricingRules.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const counterpartyId = c.req.query("counterpartyId");
  if (counterpartyId === undefined) return c.json(invalidRequest(), 400);

  // 越境 ID は DB へ行く前に 404（`assertIdBelongsToTenant()`）。
  const counterparty = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (counterparty === undefined) return c.json({ error: "RESOURCE_NOT_FOUND" as const }, 404);

  const propertyId = c.req.query("propertyId");
  const effectiveOn = c.req.query("effectiveOn");

  const rows = await listPricingRules(c.env, ctx, {
    counterpartyId,
    ...(propertyId === undefined ? {} : { propertyId }),
    ...(effectiveOn === undefined ? {} : { effectiveOn }),
  });

  const body: PricingRuleListResponse = { counterpartyId, data: rows.map(toSummary) };
  return c.json(body);
});

/** 登録。**梯子に載らない形は 400。** */
pricingRules.post("/", async (c) => {
  const parsed = pricingRuleCreateSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const input = parsed.data;
  const shape = {
    propertyId: input.propertyId ?? null,
    roomTypeId: input.roomTypeId ?? null,
    taskType: input.taskType ?? null,
  };

  if (pricingRuleStage(shape) === null) {
    // 選ばれることのない設定を黙って保存しない（§11「料金設定の抜けで請求漏れ」）。
    return c.json({ error: "UNRESOLVABLE_RULE_SHAPE" as const }, 400);
  }

  if (input.validTo !== undefined && input.validTo !== null && input.validTo < input.validFrom) {
    return c.json(invalidRequest(), 400);
  }

  const counterparty = await findCounterpartyById(c.env, ctx, input.counterpartyId);
  if (counterparty === undefined) return c.json({ error: "RESOURCE_NOT_FOUND" as const }, 404);

  const pricingRuleId = await insertPricingRule(c.env, ctx, {
    counterpartyId: input.counterpartyId,
    ...shape,
    itemCode: input.itemCode,
    unitPrice: input.unitPrice,
    taxRate: input.taxRate ?? 10,
    isReducedRate: input.isReducedRate ?? false,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    priority: input.priority ?? 50,
  });

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "pricingRule.created",
    targetType: "pricingRule",
    targetId: pricingRuleId,
    ...(shape.propertyId === null ? {} : { propertyId: shape.propertyId }),
    after: {
      counterpartyId: input.counterpartyId,
      ...shape,
      itemCode: input.itemCode,
      unitPrice: input.unitPrice,
      taxRate: input.taxRate ?? 10,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
    },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ pricingRuleId }, 201);
});

/** 期間を閉じる。**`validTo` の当日まで有効**（`isEffectiveOn()` は両端を含む）。 */
pricingRules.patch("/:pricingRuleId", async (c) => {
  const parsed = pricingRuleCloseSchema.safeParse(await readJson(c.req.raw));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const pricingRuleId = c.req.param("pricingRuleId");
  const before = await findPricingRuleById(c.env, ctx, pricingRuleId);
  if (before === undefined) return c.json({ error: "RESOURCE_NOT_FOUND" as const }, 404);

  if (parsed.data.validTo < before.validFrom) return c.json(invalidRequest(), 400);

  await closePricingRule(c.env, ctx, pricingRuleId, parsed.data.validTo);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "pricingRule.closed",
    targetType: "pricingRule",
    targetId: pricingRuleId,
    ...(before.propertyId === null ? {} : { propertyId: before.propertyId }),
    before: { validFrom: before.validFrom, validTo: before.validTo, unitPrice: before.unitPrice },
    after: { validTo: parsed.data.validTo },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ pricingRuleId });
});

/** 一覧の 1 件。**`organizationId` を落とし、§3.2 の段を添える。** */
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

function ipOf(ip: string | undefined): { ip?: string } {
  return ip === undefined ? {} : { ip };
}

export default pricingRules;
