/**
 * 支払集計の実行と確定（P5-18 / docs/PK-SPEC-PAY.md §2・§3）。
 *
 * ルール: .claude/rules/billing.md §4・§5 / security.md §5
 *
 * ── 再計算方式（冪等）────────────────────────────────────
 * 同じ月を 3 回集計しても結果が変わらない。TASK 行は毎回作り直し、
 * 調整行（手入力）は保持する（`replacePayoutTaskLines()` の注記）。
 *
 * ── CPU の予算 ──────────────────────────────────────────
 * 集計は D1 の読み書き（I/O）が大半で、計算そのもの（`buildPayoutDraft()`）は
 * グループ化と整数演算だけ。管理者が月に数回押す操作であり、Queue へ
 * 逃がすほどの CPU を使わない。スタッフ数が数百人規模になったら
 * `pdf-generation` と同じ形でコンシューマへ移すこと。
 */

import {
  buildPayoutDraft,
  fiscalYearOf,
  type PayableWork,
  type PayRuleCandidate,
} from "@pk/billing";
import {
  ensurePayoutPeriod,
  findPayoutPeriodById,
  findTaxProfile,
  listPayoutLines,
  listPayRules,
  listProperties,
  listTasks,
  listTimeLogsByTaskIds,
  replacePayoutTaskLines,
  updatePayoutPeriodStatus,
  type Env,
  type TenantContext,
} from "@pk/db";
import { actualMinutesOf } from "@pk/engine";

import { issueDocumentNumber } from "../document/sequencer.js";

/** 対象月（`YYYY-MM`）→ 期間（業務日基準の暦月）。 */
export function payoutMonthRange(month: string): { periodFrom: string; periodTo: string } {
  const [yearRaw, monthRaw] = month.split("-");
  const year = Number(yearRaw);
  const monthNumber = Number(monthRaw);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber)) throw new Error("INVALID_MONTH");
  // その月の末日。UTC で組んで日数だけを読む（時刻に依存しない）。
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mm = String(monthNumber).padStart(2, "0");
  return {
    periodFrom: `${String(year)}-${mm}-01`,
    periodTo: `${String(year)}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

export type AggregateOutcome =
  | { kind: "AGGREGATED"; payoutPeriodId: string; totalAmount: number }
  /** 確定済みの期間。**動かさない**（PAY §3.1）。 */
  | { kind: "CONFIRMED_SKIPPED"; payoutPeriodId: string };

/**
 * 1 スタッフ × 1 月を集計する。**冪等。**
 *
 * `OPEN → REVIEWING`。既に `REVIEWING` なら TASK 行と合計を作り直す。
 * `CONFIRMED` は触らない。
 */
export async function aggregateStaffPayout(
  env: Env,
  ctx: TenantContext,
  input: { membershipId: string; month: string },
): Promise<AggregateOutcome> {
  const range = payoutMonthRange(input.month);
  const ensured = await ensurePayoutPeriod(env, ctx, {
    membershipId: input.membershipId,
    ...range,
  });

  const period = await findPayoutPeriodById(env, ctx, ensured.id);
  if (period === undefined) throw new Error("PAYOUT_PERIOD_MISSING");
  if (period.status === "CONFIRMED") {
    return { kind: "CONFIRMED_SKIPPED", payoutPeriodId: period.id };
  }

  const [tasks, rules, properties] = await Promise.all([
    listTasks(env, ctx, {
      assigneeId: input.membershipId,
      businessDateFrom: range.periodFrom,
      businessDateTo: range.periodTo,
      status: ["COMPLETED"],
    }),
    listPayRules(env, ctx),
    listProperties(env, ctx),
  ]);
  const propertyNames = new Map(properties.map((row) => [row.id, row.name]));

  // HOURLY の単価が 1 本も無ければ時間ログは読まない（往復を減らす）。
  const needsMinutes = rules.some((rule) => rule.unitType === "HOURLY");
  const logsByTask = needsMinutes
    ? await listTimeLogsByTaskIds(
        env,
        ctx,
        tasks.map((task) => task.id),
      )
    : new Map<string, { event: string; occurredAt: number }[]>();

  const works: PayableWork[] = tasks.map((task) => {
    const logs = logsByTask.get(task.id);
    return {
      taskId: task.id,
      membershipId: input.membershipId,
      propertyId: task.propertyId,
      propertyName: propertyNames.get(task.propertyId) ?? task.propertyId,
      taskType: task.taskType,
      businessDate: task.businessDate,
      // **`cleaningTask.actualMinutes` 列を使わない**（キャッシュ / schema の注記）。
      actualMinutes: logs === undefined ? null : actualMinutesOf(logs),
    };
  });

  const draft = buildPayoutDraft({
    works,
    rules: rules.map(
      (rule): PayRuleCandidate => ({
        id: rule.id,
        membershipId: rule.membershipId,
        propertyId: rule.propertyId,
        taskType: rule.taskType,
        unitType: rule.unitType,
        unitPrice: rule.unitPrice,
        validFrom: rule.validFrom,
        validTo: rule.validTo,
        priority: rule.priority,
      }),
    ),
  });

  await replacePayoutTaskLines(env, ctx, period.id, draft.lines);

  // 合計 = TASK 行 ＋ 残っている調整行。
  const lines = await listPayoutLines(env, ctx, period.id);
  const totalAmount = lines.reduce((sum, line) => sum + line.amount, 0);

  const changed = await updatePayoutPeriodStatus(
    env,
    ctx,
    period.id,
    { status: "REVIEWING", aggregatedAt: ctx.now, totalAmount },
    period.status,
  );
  // 0 行 = 並行して確定まで進んだ。**上書きしない。**
  if (changed === 0) return { kind: "CONFIRMED_SKIPPED", payoutPeriodId: period.id };

  return { kind: "AGGREGATED", payoutPeriodId: period.id, totalAmount };
}

export type ConfirmOutcome =
  | { kind: "CONFIRMED"; documentNo: string; totalAmount: number }
  | { kind: "REJECTED"; reason: "NOT_REVIEWING" | "TAX_PROFILE_NOT_FOUND" };

/**
 * 支払期間を確定する（PAY §3.1・§3.2）。
 *
 * 採番（`PAY-{年度}-{連番4桁}`）は `DocumentSequencer` 経由のみ。
 * **確定後の行は動かない**（訂正は次の期間にマイナスの調整行）。
 */
export async function confirmPayoutPeriod(
  env: Env,
  ctx: TenantContext,
  payoutPeriodId: string,
): Promise<ConfirmOutcome | undefined> {
  const period = await findPayoutPeriodById(env, ctx, payoutPeriodId);
  if (period === undefined) return undefined;
  if (period.status !== "REVIEWING") return { kind: "REJECTED", reason: "NOT_REVIEWING" };

  const taxProfile = await findTaxProfile(env, ctx);
  if (taxProfile === undefined) return { kind: "REJECTED", reason: "TAX_PROFILE_NOT_FOUND" };

  const lines = await listPayoutLines(env, ctx, payoutPeriodId);
  const totalAmount = lines.reduce((sum, line) => sum + line.amount, 0);

  const issued = await issueDocumentNumber(env, {
    organizationId: ctx.organizationId,
    documentType: "PAYOUT",
    fiscalYear: fiscalYearOf(period.periodTo, taxProfile.fiscalYearStartMonth),
  });

  const changed = await updatePayoutPeriodStatus(
    env,
    ctx,
    payoutPeriodId,
    {
      status: "CONFIRMED",
      confirmedAt: ctx.now,
      documentNo: issued.documentNumber,
      totalAmount,
    },
    "REVIEWING",
  );
  // 0 行 = 別のリクエストが先に確定した。**番号は欠番のまま残る**
  // （billing.md §5 は欠番を許容する。再利用しない）。
  if (changed === 0) return { kind: "REJECTED", reason: "NOT_REVIEWING" };

  return { kind: "CONFIRMED", documentNo: issued.documentNumber, totalAmount };
}
