/**
 * スタッフ支払集計の API（P5-18 / docs/PK-SPEC-PAY.md）。
 *
 * ```
 * GET  /api/v1/payouts?month=YYYY-MM
 * POST /api/v1/payouts/aggregate            { month, membershipId? }
 * GET  /api/v1/payouts/export?month=YYYY-MM   CSV（給与ソフト連携 / PAY §3.2）
 * GET  /api/v1/payouts/:payoutPeriodId/lines
 * POST /api/v1/payouts/:payoutPeriodId/adjustments
 * POST /api/v1/payouts/:payoutPeriodId/confirm
 * ```
 *
 * ── 門は `payout.read` / `payout.write`（OWNER / ORG_ADMIN のみ）─
 * 単価と支払額を施設責任者・発注元・監査閲覧に出さない（PAY §4）。
 *
 * ── Idempotency ─────────────────────────────────────────
 * `aggregate` は再計算方式（何度押しても同じ結果）、`confirm` は
 * 楽観ロック（2 回目は 409）。**鍵の記録という別の状態を作らない**
 * （DECISIONS #055 と同じ判断）。`adjustments` だけは再送で行が増える —
 * 管理画面の操作であり、増えた行は画面で見えて赤伝で正せる。
 *
 * ── 物理削除の口が無い ──────────────────────────────────
 * CONFIRMED の期間・明細を消す API を作らない（PAY §3.1 / billing.md §2）。
 */

import {
  payoutAdjustmentRequestSchema,
  payoutAggregateRequestSchema,
  payoutMonthSchema,
  type PayoutLinesResponse,
  type PayoutListResponse,
  type PayoutPeriodSummary,
} from "@pk/contracts";
import {
  addAdjustmentLine,
  findPayoutPeriodById,
  findTaxProfile,
  listOrgMembers,
  listPayoutLines,
  listPayoutPeriods,
  listStaffPayProfiles,
  recordAudit,
} from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import {
  aggregateStaffPayout,
  confirmPayoutPeriod,
  enqueuePayoutPdf,
  payoutMonthRange,
} from "../../../lib/payout/aggregate.js";
import { signObjectUrl } from "../../../lib/storage/signedUrl.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const payouts = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

function notFound() {
  return { error: "RESOURCE_NOT_FOUND" as const };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** 月の一覧。スタッフ名は支払の運用に要る（PAY §0.2 — 序列化はしない）。 */
payouts.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "payout.read", ORGANIZATION_TARGET);

  const month = payoutMonthSchema.safeParse(c.req.query("month"));
  if (!month.success) return c.json(invalidRequest(), 400);
  const range = payoutMonthRange(month.data);

  const [periods, members, profiles] = await Promise.all([
    listPayoutPeriods(c.env, ctx, { periodToFrom: range.periodTo, periodFromTo: range.periodFrom }),
    listOrgMembers(c.env, ctx),
    listStaffPayProfiles(c.env, ctx),
  ]);
  const memberOf = new Map(members.map((member) => [member.membershipId, member]));
  const profileOf = new Map(profiles.map((profile) => [profile.membershipId, profile]));

  const data: PayoutPeriodSummary[] = periods.map((period) => ({
    payoutPeriodId: period.id,
    membershipId: period.membershipId,
    staffName: memberOf.get(period.membershipId)?.displayName ?? "",
    staffNumber: memberOf.get(period.membershipId)?.staffNumber ?? "",
    employmentType: profileOf.get(period.membershipId)?.employmentType ?? null,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    status: period.status,
    documentNo: period.documentNo,
    totalAmount: period.totalAmount,
  }));

  const body: PayoutListResponse = { data };
  return c.json(body);
});

/**
 * 集計の実行（`OPEN → REVIEWING` / 再計算）。**冪等。**
 *
 * `membershipId` を省略すると、有効な支払属性を持つ全スタッフを順に集計する。
 * 対象は数十人規模（PK-BIZ-PLAN の想定顧客）で、処理は D1 の I/O が大半。
 */
payouts.post("/aggregate", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "payout.write", ORGANIZATION_TARGET);

  const parsed = payoutAggregateRequestSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json(invalidRequest(), 400);
  const { month, membershipId } = parsed.data;

  const targets =
    membershipId !== undefined
      ? [membershipId]
      : (await listStaffPayProfiles(c.env, ctx))
          .filter((profile) => profile.isActive)
          .map((profile) => profile.membershipId);

  const results = [];
  for (const target of targets) {
    const outcome = await aggregateStaffPayout(c.env, ctx, { membershipId: target, month });
    results.push({ membershipId: target, ...outcome });
  }

  return c.json({ month, results }, 200);
});

/** CSV（給与ソフト連携 / PAY §3.2）。**その場で組んで返す。保存しない。** */
payouts.get("/export", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "payout.read", ORGANIZATION_TARGET);

  const month = payoutMonthSchema.safeParse(c.req.query("month"));
  if (!month.success) return c.json(invalidRequest(), 400);
  const range = payoutMonthRange(month.data);

  const [periods, members, profiles] = await Promise.all([
    listPayoutPeriods(c.env, ctx, { periodToFrom: range.periodTo, periodFromTo: range.periodFrom }),
    listOrgMembers(c.env, ctx),
    listStaffPayProfiles(c.env, ctx),
  ]);
  const memberOf = new Map(members.map((member) => [member.membershipId, member]));
  const profileOf = new Map(profiles.map((profile) => [profile.membershipId, profile]));

  // 列は最小の共通集合（スタッフ番号・氏名・区分・期間・状態・番号・金額）。
  // 給与ソフト各社の書式への個別対応は PAY §6-3（未決）。
  const escape = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const rows = [
    ["staff_number", "staff_name", "employment_type", "period_from", "period_to", "status", "document_no", "total_amount"],
    ...periods.map((period) => [
      memberOf.get(period.membershipId)?.staffNumber ?? "",
      memberOf.get(period.membershipId)?.displayName ?? "",
      profileOf.get(period.membershipId)?.employmentType ?? "",
      period.periodFrom,
      period.periodTo,
      period.status,
      period.documentNo ?? "",
      String(period.totalAmount),
    ]),
  ];
  const csv = rows.map((row) => row.map(escape).join(",")).join("\r\n");

  return c.body(csv, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="payout-${month.data}.csv"`,
  });
});

/** 明細。TASK 行（1〜）と調整行（1001〜）の番号帯は分けてある。 */
payouts.get("/:payoutPeriodId/lines", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "payout.read", ORGANIZATION_TARGET);

  const payoutPeriodId = c.req.param("payoutPeriodId");
  const period = await findPayoutPeriodById(c.env, ctx, payoutPeriodId);
  if (period === undefined) return c.json(notFound(), 404);

  const lines = await listPayoutLines(c.env, ctx, payoutPeriodId);
  const body: PayoutLinesResponse = {
    payoutPeriodId: period.id,
    status: period.status,
    totalAmount: lines.reduce((sum, line) => sum + line.amount, 0),
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      lineType: line.lineType,
      propertyId: line.propertyId,
      description: line.description,
      quantity: line.quantity,
      unitType: line.unitType,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taskCount: line.taskIds.length,
      reason: line.reason,
      warning: line.warning,
    })),
  };
  return c.json(body);
});

/**
 * 支払明細書 PDF の取得（PAY §3.2）。**確定済みのみ。**
 *
 * 署名付き URL（15 分）を返す。R2 のキーそのものは返さない
 * （`invoices.ts` の PDF 取得と同じ形）。
 */
payouts.get("/:payoutPeriodId/pdf", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "payout.read", ORGANIZATION_TARGET);

  const payoutPeriodId = c.req.param("payoutPeriodId");
  const period = await findPayoutPeriodById(c.env, ctx, payoutPeriodId);
  if (period === undefined) return c.json(notFound(), 404);
  // 確定前に PDF は無い（PDF は確定の後工程）。
  if (period.status !== "CONFIRMED") return c.json({ error: "PDF_NOT_READY" as const }, 409);

  if (period.pdfStorageKey === null) {
    // まだ生成中か、確定時の投入に失敗した。**投げ直して 409 を返す**
    // （冪等: 同じ文書番号なら同じキーへ同じ内容が載る）。regenerate の
    // 専用 API は作らない（発行済み帳票の更新の口を増やさない / PAY §3.2）。
    const taxProfile = await findTaxProfile(c.env, ctx);
    await enqueuePayoutPdf(c.env, ctx, {
      payoutPeriodId,
      sealImageKey: taxProfile?.sealImageKey ?? null,
    });
    return c.json({ error: "PDF_NOT_READY" as const }, 409);
  }

  return c.json({
    url: await signObjectUrl(c.env.SESSION_SECRET, period.pdfStorageKey, ctx.now),
    documentNo: period.documentNo,
  });
});

/** 調整行（追加対応・立替金）。**理由必須**（PAY §1.4）。 */
payouts.post("/:payoutPeriodId/adjustments", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "payout.write", ORGANIZATION_TARGET);

  const parsed = payoutAdjustmentRequestSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json(invalidRequest(), 400);

  const payoutPeriodId = c.req.param("payoutPeriodId");
  const period = await findPayoutPeriodById(c.env, ctx, payoutPeriodId);
  if (period === undefined) return c.json(notFound(), 404);
  // 確定後は動かさない（PAY §3.1）。訂正は次の期間にマイナスの調整行。
  if (period.status === "CONFIRMED") return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  const added = await addAdjustmentLine(c.env, ctx, {
    payoutPeriodId,
    lineType: parsed.data.lineType,
    description: parsed.data.description,
    amount: parsed.data.amount,
    reason: parsed.data.reason,
  });

  return c.json({ payoutPeriodId, lineNo: added.lineNo }, 201);
});

/** 確定（`REVIEWING → CONFIRMED` / 採番）。**2 回目は 409。** */
payouts.post("/:payoutPeriodId/confirm", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "payout.write", ORGANIZATION_TARGET);

  const payoutPeriodId = c.req.param("payoutPeriodId");
  const outcome = await confirmPayoutPeriod(c.env, ctx, payoutPeriodId);
  if (outcome === undefined) return c.json(notFound(), 404);
  if (outcome.kind === "REJECTED") {
    return c.json(
      { error: outcome.reason === "NOT_REVIEWING" ? ("INVALID_TRANSITION" as const) : ("TAX_PROFILE_NOT_FOUND" as const) },
      409,
    );
  }

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "payout.confirmed",
    targetType: "payoutPeriod",
    targetId: payoutPeriodId,
    after: { documentNo: outcome.documentNo, totalAmount: outcome.totalAmount },
  });

  return c.json({ payoutPeriodId, documentNo: outcome.documentNo, totalAmount: outcome.totalAmount });
});

export default payouts;
