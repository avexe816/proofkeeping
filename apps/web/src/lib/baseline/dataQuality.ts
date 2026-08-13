/**
 * データ品質の組み立て（PK-SPEC-P3 §6.3 / W-22）。
 *
 * task:  docs/tasks/P3-12.md
 * ルール: .claude/rules/security.md §5（従業員データ）
 *
 * ── 計算はここでしない ──────────────────────────────────
 * 率と平均を出すのは `packages/engine` の `computeDataQuality()`。
 * この層の仕事は**読み取りと写像だけ。** API（`routes/api/v1/dataQuality.ts`）
 * と画面（W-22）の両方から呼ぶ。
 *
 * ── 個人の比較にしない（INV-07）─────────────────────────
 * スタッフ別に出すのは入力率だけ。表示名は**「氏名 (スタッフ番号)」**
 * （§6.3 の例）で、順位も差分も付けない。20 タスク未満は
 * `display: false` で返り、画面が率を出さない。
 */

import type {
  BaselineMaturitySummary,
  DataQualityResponse,
  StaffInputRateSummary,
} from "@pk/contracts";
import {
  listBaselineExclusions,
  listBaselines,
  listObservations,
  listPropertyStaff,
  listRoomTypes,
  listTasks,
  type Env,
  type TenantContext,
} from "@pk/db";
import { computeDataQuality, dataQualityStatuses } from "@pk/engine";

import { shiftBusinessDate } from "../businessDate.js";
import { canViewStaffName } from "../ui/staffName.js";

/** 対象月（`YYYY-MM`）の業務日の範囲。 */
export interface MonthRange {
  from: string;
  to: string;
}

/**
 * `YYYY-MM` から業務日の閉区間を作る。
 *
 * **月末は月ごとに違う。** 翌月 1 日の前日を取る（うるう年もこれで足りる）。
 * 形が違えば `null`（呼び出し側が 400 にする）。
 */
export function monthRangeOf(month: string): MonthRange | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const from = `${month}-01`;
  const parsed = new Date(`${from}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const nextMonth = new Date(parsed);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return { from, to: shiftBusinessDate(nextMonth.toISOString().slice(0, 10), -1) };
}

/**
 * 施設 1 つ・1 か月ぶんの入力品質を組み立てる。
 *
 * ── 分母は「その月のタスク」──────────────────────────
 * 入力率・未記録率の分母は観察の対象になりうるタスク。**キャンセル済みも
 * 含めない形にしていない**のは、`cleaningTask` の状態でふるいに掛けると
 * 「対象タスク」の定義が画面ごとに割れるため。§6.3 も母数を定義して
 * いないので、その月に立ったタスクをそのまま数える。
 */
export async function collectDataQuality(
  env: Env,
  ctx: TenantContext,
  input: { propertyId: string; month: string; range: MonthRange },
): Promise<DataQualityResponse> {
  const { propertyId, month, range } = input;

  const tasks = await listTasks(env, ctx, {
    propertyId,
    businessDateFrom: range.from,
    businessDateTo: range.to,
  });
  const observations = await listObservations(env, ctx, {
    propertyId,
    from: range.from,
    to: range.to,
  });
  const exclusions = await listBaselineExclusions(env, ctx, {
    propertyId,
    from: range.from,
    to: range.to,
  });
  const baselines = await listBaselines(env, ctx, { propertyId });

  const observedTaskIds = new Set(observations.map((row) => row.taskId));

  const quality = computeDataQuality({
    tasks: tasks.map((task) => ({
      taskId: task.id,
      hasObservation: observedTaskIds.has(task.id),
      observationSkipped: task.observationSkipped,
      assigneeId: task.assigneeId,
    })),
    observations: observations.map((row) => ({
      observationId: row.id,
      usedDefaults: row.usedDefaults,
      inputDurationMs: row.inputDurationMs,
    })),
    excludedObservationIds: exclusions.map((row) => row.observationId),
    baselines: baselines.map((row) => ({
      roomTypeId: row.roomTypeId,
      guestCount: row.guestCount,
      isReliable: row.isReliable,
    })),
  });

  const staffInputRates = await withStaffNames(env, ctx, propertyId, quality.staffInputRates);
  const maturity = await withRoomTypeNames(env, ctx, propertyId, quality.maturity.combinations);

  return {
    propertyId,
    month,
    from: range.from,
    to: range.to,
    inputRate: quality.inputRate,
    defaultRate: quality.defaultRate,
    averageInputMs: quality.inputDuration.averageMs,
    inputDurationCount: quality.inputDuration.count,
    exclusionRate: quality.exclusionRate,
    skipRate: quality.skipRate,
    statuses: dataQualityStatuses(quality),
    staffInputRates,
    maturity,
    reliableCombinationCount: quality.maturity.reliableCount,
    totalCombinationCount: quality.maturity.totalCount,
  };
}

/**
 * `membership.id` → 「氏名 (スタッフ番号)」（§6.3 の例）。
 *
 * **`canViewStaffName()` が偽のロールには氏名を出さない**（INV-06）。
 * `OWNER` / `AUDITOR` はスタッフ番号だけを見る。空欄にはしない
 * （`lib/ui/staffName.ts` の注記）。
 */
async function withStaffNames(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  rates: readonly { assigneeId: string; rate: StaffInputRateSummary["rate"]; display: boolean }[],
): Promise<StaffInputRateSummary[]> {
  if (rates.length === 0) return [];
  const showName = canViewStaffName(ctx.role);
  const staff = await listPropertyStaff(env, ctx, propertyId);
  const labelByMembershipId = new Map<string, string>();
  for (const person of staff) {
    labelByMembershipId.set(
      person.membershipId,
      showName ? `${person.displayName} (${person.staffNumber})` : person.staffNumber,
    );
  }
  return rates.map((entry) => ({
    assigneeId: entry.assigneeId,
    // 引けない（退職・割当解除）場合は空。画面が i18n の代替表示にする。
    displayName: labelByMembershipId.get(entry.assigneeId) ?? "",
    rate: entry.rate,
    display: entry.display,
  }));
}

/** 客室タイプ ID → 名称（§6.3 下段の「ツイン×3名」）。 */
async function withRoomTypeNames(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  combinations: readonly {
    roomTypeId: string;
    guestCount: number;
    itemCount: number;
    reliableItemCount: number;
    isReliable: boolean;
  }[],
): Promise<BaselineMaturitySummary[]> {
  if (combinations.length === 0) return [];
  const roomTypes = await listRoomTypes(env, ctx, propertyId, {});
  const nameById = new Map(roomTypes.map((roomType) => [roomType.id, roomType.name]));
  return combinations.map((combination) => ({
    roomTypeId: combination.roomTypeId,
    roomTypeName: nameById.get(combination.roomTypeId) ?? "",
    guestCount: combination.guestCount,
    itemCount: combination.itemCount,
    reliableItemCount: combination.reliableItemCount,
    isReliable: combination.isReliable,
  }));
}
