/**
 * スタッフ支払集計のリポジトリ（P5-18 / docs/PK-SPEC-PAY.md）。
 *
 * ルール: .claude/rules/architecture.md §2 / billing.md §4・§5 / security.md §5
 *
 * ── 施設スコープを掛けない ──────────────────────────────
 * 4 表とも `NO_PROPERTY_SCOPE`。`payRule.propertyId` / `payoutLine.propertyId`
 * は null（全施設・調整行）を取りうる列で、施設スコープを掛けると
 * 「全施設」の行が消える（`pricingRule` と同じ判断）。到達の制限は
 * `payout.read` / `payout.write`（OWNER / ORG_ADMIN のみ）が担う。
 *
 * ── CONFIRMED の行は動かさない（PAY §3.1）────────────────
 * 再集計（`replacePayoutTaskLines()`）と調整行の追加は、呼び出し側が
 * 状態を見てから呼ぶ。`updatePayoutPeriodStatus()` は楽観ロックで、
 * CONFIRMED からの遷移は状態機械（`@pk/billing` 側は持たないため
 * `PAYOUT_PERIOD_STATUSES` の並びをここで守る）に無い。
 *
 * ── 支払明細書の削除関数を作らない ──────────────────────
 * CONFIRMED（= 採番済み）の期間・明細を消す関数を足さないこと。
 * 訂正は次の期間にマイナスの調整行（赤伝方式 / PAY §3.1）。
 */

import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { chunkIdsForInArray } from "../limits.js";
import { getTenantDb, type TenantContext } from "../router.js";
import {
  payoutLine,
  payoutPeriod,
  payRule,
  staffPayProfile,
  type EmploymentType,
  type PayoutLineType,
  type PayoutPeriodStatus,
  type PayUnitType,
} from "../schema/payout.js";
import { taskTimeLog } from "../schema/task.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

// ────────────────────────────────────────────────────────────
// スタッフの支払属性（PAY §1.1）
// ────────────────────────────────────────────────────────────

export async function listStaffPayProfiles(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(staffPayProfile)
    .where(withTenantScope(staffPayProfile, ctx, NO_PROPERTY_SCOPE))
    .orderBy(staffPayProfile.membershipId);
}

export interface UpsertStaffPayProfileInput {
  membershipId: string;
  employmentType: EmploymentType;
  /** T+13 桁。CONTRACTOR のみ（呼び出し側が形を検証する）。 */
  invoiceRegistrationNo: string | null;
  isActive: boolean;
}

/** 1 スタッフ 1 行（`uq_staff_pay_profile`）。2 回目は更新になる。 */
export async function upsertStaffPayProfile(
  env: Env,
  ctx: TenantContext,
  input: UpsertStaffPayProfileInput,
): Promise<{ id: string }> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  const id = generateId(ctx.orgShortId, "sppf");

  await db
    .insert(staffPayProfile)
    .values({
      id,
      organizationId: ctx.organizationId,
      membershipId: input.membershipId,
      employmentType: input.employmentType,
      invoiceRegistrationNo: input.invoiceRegistrationNo,
      isActive: input.isActive,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [staffPayProfile.organizationId, staffPayProfile.membershipId],
      set: {
        employmentType: input.employmentType,
        invoiceRegistrationNo: input.invoiceRegistrationNo,
        isActive: input.isActive,
        updatedAt: ctx.now,
      },
    });

  const rows = await db
    .select({ id: staffPayProfile.id })
    .from(staffPayProfile)
    .where(
      withTenantScope(
        staffPayProfile,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(staffPayProfile.membershipId, input.membershipId),
      ),
    )
    .limit(1);
  return { id: rows[0]?.id ?? id };
}

// ────────────────────────────────────────────────────────────
// 支払単価（PAY §1.2）
// ────────────────────────────────────────────────────────────

export interface PayRuleFilter {
  membershipId?: string | undefined;
}

/** 単価の一覧。**`priority` の小さいほうが先**（採られる行が上に来る）。 */
export async function listPayRules(env: Env, ctx: TenantContext, filter: PayRuleFilter = {}) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(payRule)
    .where(
      withTenantScope(
        payRule,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.membershipId === undefined
          ? undefined
          : eq(payRule.membershipId, filter.membershipId),
      ),
    )
    .orderBy(payRule.priority, desc(payRule.validFrom), payRule.id);
}

export interface InsertPayRuleInput {
  membershipId: string | null;
  propertyId: string | null;
  taskType: string | null;
  unitType: PayUnitType;
  /** 円。整数のみ（billing.md §4）。 */
  unitPrice: number;
  validFrom: string | null;
  validTo: string | null;
  priority: number;
}

export async function insertPayRule(
  env: Env,
  ctx: TenantContext,
  input: InsertPayRuleInput,
): Promise<{ id: string }> {
  if (input.membershipId !== null) assertIdBelongsToTenant(input.membershipId, ctx);
  if (input.propertyId !== null) assertIdBelongsToTenant(input.propertyId, ctx);
  if (!Number.isInteger(input.unitPrice) || input.unitPrice < 0) {
    throw new Error("INVALID_UNIT_PRICE");
  }
  const db = await getTenantDb(env, ctx);
  const id = generateId(ctx.orgShortId, "payr");
  await db.insert(payRule).values({
    id,
    organizationId: ctx.organizationId,
    membershipId: input.membershipId,
    propertyId: input.propertyId,
    taskType: input.taskType as never,
    unitType: input.unitType,
    unitPrice: input.unitPrice,
    validFrom: input.validFrom,
    validTo: input.validTo,
    priority: input.priority,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return { id };
}

/** 単価を閉じる（値上げは行の追加で表す / `pricingRule` と同じ扱い）。 */
export async function closePayRule(
  env: Env,
  ctx: TenantContext,
  payRuleId: string,
  validTo: string,
): Promise<number> {
  assertIdBelongsToTenant(payRuleId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(payRule)
    .set({ validTo, updatedAt: ctx.now })
    .where(and(eq(payRule.organizationId, ctx.organizationId), eq(payRule.id, payRuleId)));
  return result.meta.changes;
}

// ────────────────────────────────────────────────────────────
// 支払期間（PAY §1.3）
// ────────────────────────────────────────────────────────────

/** 期間の行を用意する。**冪等**（`uq_payout_period`）。 */
export async function ensurePayoutPeriod(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; periodFrom: string; periodTo: string },
): Promise<{ id: string; created: boolean }> {
  assertIdBelongsToTenant(input.membershipId, ctx);
  const db = await getTenantDb(env, ctx);

  const find = () =>
    db
      .select({ id: payoutPeriod.id })
      .from(payoutPeriod)
      .where(
        withTenantScope(
          payoutPeriod,
          ctx,
          NO_PROPERTY_SCOPE,
          eq(payoutPeriod.membershipId, input.membershipId),
          eq(payoutPeriod.periodFrom, input.periodFrom),
          eq(payoutPeriod.periodTo, input.periodTo),
        ),
      )
      .limit(1);

  const existing = await find();
  const held = existing[0];
  if (held !== undefined) return { id: held.id, created: false };

  const id = generateId(ctx.orgShortId, "pout");
  const inserted = await db
    .insert(payoutPeriod)
    .values({
      id,
      organizationId: ctx.organizationId,
      membershipId: input.membershipId,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing();
  if (inserted.meta.changes > 0) return { id, created: true };

  // 競合した（別リクエストが先に作った）。引き直す。
  const raced = await find();
  const won = raced[0];
  if (won === undefined) throw new Error("PAYOUT_PERIOD_ENSURE_FAILED");
  return { id: won.id, created: false };
}

export interface PayoutPeriodFilter {
  membershipId?: string | undefined;
  status?: readonly PayoutPeriodStatus[] | undefined;
  periodToFrom?: string | undefined;
  periodFromTo?: string | undefined;
  limit?: number | undefined;
}

export async function listPayoutPeriods(
  env: Env,
  ctx: TenantContext,
  filter: PayoutPeriodFilter = {},
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(payoutPeriod)
    .where(
      withTenantScope(
        payoutPeriod,
        ctx,
        NO_PROPERTY_SCOPE,
        filter.membershipId === undefined
          ? undefined
          : eq(payoutPeriod.membershipId, filter.membershipId),
        filter.status === undefined ? undefined : inArray(payoutPeriod.status, [...filter.status]),
        filter.periodToFrom === undefined
          ? undefined
          : gte(payoutPeriod.periodTo, filter.periodToFrom),
        filter.periodFromTo === undefined
          ? undefined
          : lte(payoutPeriod.periodFrom, filter.periodFromTo),
      ),
    )
    .orderBy(desc(payoutPeriod.periodTo), payoutPeriod.membershipId)
    .limit(filter.limit ?? 200);
}

/** 1 件。**越境 ID は DB へ行く前に `NotFoundError`。** */
export async function findPayoutPeriodById(env: Env, ctx: TenantContext, payoutPeriodId: string) {
  assertIdBelongsToTenant(payoutPeriodId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(payoutPeriod)
    .where(
      withTenantScope(payoutPeriod, ctx, NO_PROPERTY_SCOPE, eq(payoutPeriod.id, payoutPeriodId)),
    )
    .limit(1);
  return rows[0];
}

export interface UpdatePayoutPeriodStatusInput {
  status: PayoutPeriodStatus;
  aggregatedAt?: Date | undefined;
  confirmedAt?: Date | undefined;
  documentNo?: string | undefined;
  totalAmount?: number | undefined;
}

/**
 * 状態を進める。**楽観ロック**（`expectedBefore` と一致した行だけ動く）。
 * 0 行なら別のリクエストが先に進めている。呼び出し側は成功にしないこと。
 */
export async function updatePayoutPeriodStatus(
  env: Env,
  ctx: TenantContext,
  payoutPeriodId: string,
  input: UpdatePayoutPeriodStatusInput,
  expectedBefore: PayoutPeriodStatus,
): Promise<number> {
  assertIdBelongsToTenant(payoutPeriodId, ctx);
  const db = await getTenantDb(env, ctx);
  const result = await db
    .update(payoutPeriod)
    .set({
      status: input.status,
      ...(input.aggregatedAt === undefined ? {} : { aggregatedAt: input.aggregatedAt }),
      ...(input.confirmedAt === undefined ? {} : { confirmedAt: input.confirmedAt }),
      ...(input.documentNo === undefined ? {} : { documentNo: input.documentNo }),
      ...(input.totalAmount === undefined ? {} : { totalAmount: input.totalAmount }),
      updatedAt: ctx.now,
    })
    .where(
      and(
        eq(payoutPeriod.organizationId, ctx.organizationId),
        eq(payoutPeriod.id, payoutPeriodId),
        eq(payoutPeriod.status, expectedBefore),
      ),
    );
  return result.meta.changes;
}

// ────────────────────────────────────────────────────────────
// 明細行（PAY §1.4）
// ────────────────────────────────────────────────────────────

export async function listPayoutLines(env: Env, ctx: TenantContext, payoutPeriodId: string) {
  assertIdBelongsToTenant(payoutPeriodId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(payoutLine)
    .where(
      withTenantScope(
        payoutLine,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(payoutLine.payoutPeriodId, payoutPeriodId),
      ),
    )
    .orderBy(payoutLine.lineNo);
}

export interface ReplaceTaskLineInput {
  lineNo: number;
  propertyId: string;
  description: string;
  quantity: number;
  unitType: PayUnitType | null;
  unitPrice: number;
  amount: number;
  taskIds: string[];
  warning: string | null;
}

/**
 * TASK 行を作り直す（再計算方式 / PAY §2）。**調整行は消さない。**
 *
 * CONFIRMED の期間で呼ばないこと（呼び出し側が状態を見る）。
 * 消してよいのは**まだ確定していない集計の写し**だけで、
 * 発行済み帳票の削除にはあたらない（billing.md §2 の対象外）。
 */
export async function replacePayoutTaskLines(
  env: Env,
  ctx: TenantContext,
  payoutPeriodId: string,
  lines: readonly ReplaceTaskLineInput[],
): Promise<void> {
  assertIdBelongsToTenant(payoutPeriodId, ctx);
  const db = await getTenantDb(env, ctx);

  await db
    .delete(payoutLine)
    .where(
      and(
        eq(payoutLine.organizationId, ctx.organizationId),
        eq(payoutLine.payoutPeriodId, payoutPeriodId),
        eq(payoutLine.lineType, "TASK"),
      ),
    );

  for (const line of lines) {
    await db.insert(payoutLine).values({
      id: generateId(ctx.orgShortId, "poln"),
      organizationId: ctx.organizationId,
      payoutPeriodId,
      lineNo: line.lineNo,
      lineType: "TASK",
      propertyId: line.propertyId,
      description: line.description,
      quantity: line.quantity,
      unitType: line.unitType,
      unitPrice: line.unitPrice,
      amount: line.amount,
      taskIds: line.taskIds,
      warning: line.warning,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  }
}

/** 調整行の `lineNo` はここから。TASK 行（1〜）と番号帯を分けて再集計で動かさない。 */
export const ADJUSTMENT_LINE_NO_BASE = 1000;

export interface AddAdjustmentLineInput {
  payoutPeriodId: string;
  lineType: Exclude<PayoutLineType, "TASK">;
  description: string;
  /** 円。マイナス（赤伝の訂正）も取りうる。 */
  amount: number;
  /** 必須（PAY §1.4）。呼び出し側で空を弾いてから渡す。 */
  reason: string;
}

export async function addAdjustmentLine(
  env: Env,
  ctx: TenantContext,
  input: AddAdjustmentLineInput,
): Promise<{ id: string; lineNo: number }> {
  assertIdBelongsToTenant(input.payoutPeriodId, ctx);
  if (!Number.isInteger(input.amount)) throw new Error("INVALID_AMOUNT");
  if (input.reason.trim() === "") throw new Error("REASON_REQUIRED");
  const db = await getTenantDb(env, ctx);

  const existing = await db
    .select({ lineNo: payoutLine.lineNo })
    .from(payoutLine)
    .where(
      withTenantScope(
        payoutLine,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(payoutLine.payoutPeriodId, input.payoutPeriodId),
        gte(payoutLine.lineNo, ADJUSTMENT_LINE_NO_BASE),
      ),
    )
    .orderBy(desc(payoutLine.lineNo))
    .limit(1);

  const lineNo = (existing[0]?.lineNo ?? ADJUSTMENT_LINE_NO_BASE) + 1;
  const id = generateId(ctx.orgShortId, "poln");
  await db.insert(payoutLine).values({
    id,
    organizationId: ctx.organizationId,
    payoutPeriodId: input.payoutPeriodId,
    lineNo,
    lineType: input.lineType,
    propertyId: null,
    description: input.description,
    quantity: 1,
    unitType: null,
    unitPrice: input.amount,
    amount: input.amount,
    taskIds: [],
    reason: input.reason,
    warning: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  return { id, lineNo };
}

// ────────────────────────────────────────────────────────────
// 実働時間の一括読み（PAY §2 の HOURLY）
// ────────────────────────────────────────────────────────────

/**
 * 複数タスクの時間ログをまとめて読む。
 *
 * 集計は `@pk/engine` の `actualMinutesOf()`（`cleaningTask.actualMinutes`
 * 列を根拠にしない / schema の注記）。1 タスクずつ `listTimeLogs()` を
 * 回すと期間分の往復になるため、ここでだけ一括で読む。
 *
 * @returns taskId → イベント（時刻昇順）。ログの無いタスクは載らない。
 */
export async function listTimeLogsByTaskIds(
  env: Env,
  ctx: TenantContext,
  taskIds: readonly string[],
): Promise<Map<string, { event: string; occurredAt: number }[]>> {
  const result = new Map<string, { event: string; occurredAt: number }[]>();
  if (taskIds.length === 0) return result;
  for (const taskId of taskIds) assertIdBelongsToTenant(taskId, ctx);
  const db = await getTenantDb(env, ctx);

  for (const chunk of chunkIdsForInArray(taskIds)) {
    const rows = await db
      .select({
        taskId: taskTimeLog.taskId,
        event: taskTimeLog.event,
        occurredAt: taskTimeLog.occurredAt,
      })
      .from(taskTimeLog)
      .where(
        withTenantScope(
          taskTimeLog,
          ctx,
          NO_PROPERTY_SCOPE,
          inArray(taskTimeLog.taskId, [...chunk]),
        ),
      )
      .orderBy(taskTimeLog.occurredAt);
    for (const row of rows) {
      const held = result.get(row.taskId) ?? [];
      held.push({ event: row.event, occurredAt: row.occurredAt.getTime() });
      result.set(row.taskId, held);
    }
  }
  return result;
}
