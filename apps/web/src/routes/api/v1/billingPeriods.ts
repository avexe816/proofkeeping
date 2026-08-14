/**
 * 月次締めの API（PK-SPEC-P5 §2.8・§6.1・§9）。
 *
 * ```
 * GET  /api/v1/billing-periods?counterpartyId=&status=
 * POST /api/v1/billing-periods/:billingPeriodId/aggregate
 * ```
 *
 * task: docs/tasks/P5-05.md
 *
 * ── §9 の 4 本のうち 3 本がここに無い ───────────────────
 * `request-review` / `agree` / `reject` は**双方合意フロー（P5-12）**の
 * 担当。§6.2 MUST は「差戻しコメントと修正履歴をすべて保持する」と
 * 定めており、コメントを持つ表の設計がその task の範囲にある。
 * 状態だけ先に動かせる口を作ると、**コメントの無い差戻し**が
 * 記録に残ってしまう（「言った・言わない」を発生させないための MUST を
 * 先回りで壊す）。状態機械そのものは `@pk/billing` にあり、
 * `evaluateBillingPeriodTransition()` が 5 状態すべてを既に扱う。
 *
 * ── `aggregate` は手動の再実行 ──────────────────────────
 * 本来の起点は毎月 1 日 04:00 の Cron（`lib/billing/monthlyClose.ts`）。
 * この口は締めを取りこぼしたときに人が押すためのもので、**同じ
 * 状態機械と同じ楽観ロックを通る。** 2 回押しても 2 回進まない。
 *
 * ── 物理削除の口が無い ──────────────────────────────────
 * CLAUDE.md §4。締めの記録は請求の根拠そのもの（billing.md §2）。
 */

import {
  closedPeriodAsOf,
  evaluateBillingPeriodTransition,
  type BillingPeriodStatusValue,
} from "@pk/billing";
import {
  BILLING_PERIOD_STATUSES,
  type BillingPeriodListResponse,
  type BillingPeriodSummary,
} from "@pk/contracts";
import {
  ensureBillingPeriod,
  findBillingPeriodById,
  findCounterpartyById,
  listBillingPeriods,
  recordAudit,
  updateBillingPeriodStatus,
} from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import { getSession, getTenant, type AppEnv } from "../../../middleware/index.js";

const billingPeriods = new Hono<AppEnv>();

function invalidRequest() {
  return { error: "INVALID_REQUEST" as const };
}

function notFound() {
  return { error: "RESOURCE_NOT_FOUND" as const };
}

/** 一覧。**取引先と状態で絞れる**（§9）。 */
billingPeriods.get("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);

  const counterpartyId = c.req.query("counterpartyId");
  const statusQuery = c.req.queries("status") ?? [];
  const statuses = statusQuery.filter((value): value is BillingPeriodStatusValue =>
    (BILLING_PERIOD_STATUSES as readonly string[]).includes(value),
  );
  // **知らない状態名を黙って無視しない。** 綴り違いで全件が返ると、
  // 画面は「該当なし」ではなく「全部ある」を見せる。
  if (statuses.length !== statusQuery.length) return c.json(invalidRequest(), 400);

  const rows = await listBillingPeriods(c.env, ctx, {
    ...(counterpartyId === undefined ? {} : { counterpartyId }),
    ...(statuses.length === 0 ? {} : { status: statuses }),
  });

  const body: BillingPeriodListResponse = { data: rows.map(toSummary) };
  return c.json(body);
});

/**
 * 集計（`OPEN → REVIEWING`）。**冪等。**
 *
 * 既に `REVIEWING` 以降へ進んでいれば 409 を返す。**200 で黙って
 * 何もしないのは避ける** — 押した人は「集計し直した」と読むが、
 * 実際には古い状態のままだからである。
 */
billingPeriods.post("/:billingPeriodId/aggregate", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const billingPeriodId = c.req.param("billingPeriodId");
  const before = await findBillingPeriodById(c.env, ctx, billingPeriodId);
  if (before === undefined) return c.json(notFound(), 404);

  const transition = evaluateBillingPeriodTransition(before.status, "AGGREGATE");
  if (!transition.allowed) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  const changed = await updateBillingPeriodStatus(
    c.env,
    ctx,
    billingPeriodId,
    { status: transition.next, aggregatedAt: ctx.now },
    before.status,
  );
  // 0 なら別のリクエストが先に進めている。**状態機械の判定と DB の
  // 実際の状態がずれた**ということなので、成功にしない。
  if (changed === 0) return c.json({ error: "INVALID_TRANSITION" as const }, 409);

  await recordAudit(c.env, ctx, {
    actorId: getSession(c).membershipId,
    action: "billingPeriod.statusChanged",
    targetType: "billingPeriod",
    targetId: billingPeriodId,
    before: { status: before.status },
    after: { status: transition.next },
    ...ipOf(c.req.header("CF-Connecting-IP")),
  });

  return c.json({ billingPeriodId, status: transition.next });
});

/**
 * 取引先の「直近に締まった期間」を起票する（§6.1 の `OPEN`）。
 *
 * Cron を待たずに当月ぶんを起こしたいときの口。**期間は締め日から
 * 導き、リクエストで受け取らない。** 期間を指定できると、締め日と
 * 合わない範囲の請求書が作れてしまう。
 */
billingPeriods.post("/", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.write", ORGANIZATION_TARGET);

  const counterpartyId = c.req.query("counterpartyId");
  if (counterpartyId === undefined) return c.json(invalidRequest(), 400);

  const counterparty = await findCounterpartyById(c.env, ctx, counterpartyId);
  if (counterparty === undefined) return c.json(notFound(), 404);

  // 現地時刻の暦日。Cron（`lib/billing/monthlyClose.ts`）と同じ基準で引く。
  const onDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ctx.now);

  const range = closedPeriodAsOf(counterparty.closingDay, onDate);
  const ensured = await ensureBillingPeriod(c.env, ctx, { counterpartyId, ...range });

  return c.json({ billingPeriodId: ensured.id, ...range }, ensured.created ? 201 : 200);
});

/** 一覧の 1 件。**`organizationId` を落とす**（組織 ID を応答に出さない）。 */
function toSummary(row: {
  id: string;
  counterpartyId: string;
  periodFrom: string;
  periodTo: string;
  status: BillingPeriodStatusValue;
  aggregatedAt: Date | null;
  agreedAt: Date | null;
  agreedByCounterparty: boolean;
  invoiceId: string | null;
}): BillingPeriodSummary {
  return {
    billingPeriodId: row.id,
    counterpartyId: row.counterpartyId,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status,
    aggregatedAt: row.aggregatedAt === null ? null : row.aggregatedAt.toISOString(),
    agreedAt: row.agreedAt === null ? null : row.agreedAt.toISOString(),
    agreedByCounterparty: row.agreedByCounterparty,
    invoiceId: row.invoiceId,
  };
}

function ipOf(ip: string | undefined): { ip?: string } {
  return ip === undefined ? {} : { ip };
}

export default billingPeriods;
