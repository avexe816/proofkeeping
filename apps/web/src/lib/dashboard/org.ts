/**
 * 組織ダッシュボードの組み立て（W-02 / PK-SPEC-P5 §7.1）。
 *
 * task:  docs/tasks/P5-14.md
 * ルール: .claude/rules/architecture.md §3
 *
 * ── 稼働の数字は rollup だけを読む（§7.1 MUST）───────────
 * 「この画面のデータは `dailyPropertyRollup` から取得する。タスク
 * テーブルへの直接集計を行わない」。`listRollupsInRange()` が
 * 1 回で月ぶんを返し、ここは**足すだけ。**
 *
 * ── 例外は 3 つある ────────────────────────────────────
 *   ① 施設数・客室数 …… rollup に列が無い。施設マスタ・客室マスタを
 *      数える。**集計ではなく件数**で、P0-21 が同じ判断をしている
 *      （`lib/property/summary.ts` の注記）。
 *   ② 清掃費用 …… 発行済み請求書の明細から（DECISIONS #132）。
 *      **金額の正を rollup に二重化しない**（billing.md §6）。
 *   ③ 要対応の 4 件 …… いまの状態を数えるもので、日次の集計では
 *      表せない。既存の口をそのまま使う。
 *
 * ── 施設をまたぐ JOIN を書かない ────────────────────────
 * 読むのは 7 本の独立したクエリで、突き合わせは JS の `Map`。
 * SQL の JOIN を 1 つも書いていない（P5-14 の完了条件）。
 *
 * ── 施設スコープはリポジトリが掛ける ────────────────────
 * `PROPERTY_MANAGER` などが開いた場合、rollup も施設マスタも担当施設
 * ぶんしか返らない（第 1 層）。**ここで絞り直さない。**
 * ただし全社ビューへ到達できるかは `switchProperty()` が別に見る。
 */

import {
  countFindingsByStatus,
  countSellableRoomsByProperty,
  listBillingPeriods,
  listIssueReports,
  listLostItems,
  listRollupsInRange,
  sumInvoiceLineAmountsByProperty,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  LOST_ITEM_EXPIRY_WARNING_DAYS,
  type OrgDashboardActions,
  type OrgDashboardProperty,
  type OrgDashboardResponse,
  type OrgDashboardSummary,
} from "@pk/contracts";

import { monthRangeOf } from "../baseline/dataQuality.js";
import { businessDateOf } from "../businessDate.js";
import { listSelectableProperties } from "../property/selection.js";

/**
 * 月の範囲は `lib/baseline/dataQuality.ts` の `monthRangeOf()` を使う。
 *
 * **同じ計算を 2 つ置かない。** あちらは P3-11 が入力品質の画面のために
 * 書いたが、やっていることは「`YYYY-MM` → 業務日の閉区間」で、
 * 画面が違うだけ。月末の出し方（翌月 1 日の前日）を写経すると、
 * 片方だけ直された日にずれる。
 */
export { monthRangeOf, type MonthRange } from "../baseline/dataQuality.js";

/** `Date` → 業務日の `YYYY-MM`（architecture.md §7）。 */
export function currentMonthOf(now: Date): string {
  return businessDateOf(now).slice(0, 7);
}

/** rollup の行が持つ、この画面が使う列だけ。 */
export interface RollupRow {
  propertyId: string;
  totalTasks: number;
  completedTasks: number;
  reworkTasks: number;
  totalMinutes: number;
  inspectedTasks: number;
  firstPassTasks: number;
  findingsHigh: number;
}

/** 足し合わせた結果。**割合にしない**（`contracts/dashboard.ts` の注記）。 */
export interface RollupTotals {
  totalTasks: number;
  completedTasks: number;
  reworkTasks: number;
  totalMinutes: number;
  inspectedTasks: number;
  firstPassTasks: number;
  findingsHigh: number;
}

const ZERO_TOTALS: RollupTotals = {
  totalTasks: 0,
  completedTasks: 0,
  reworkTasks: 0,
  totalMinutes: 0,
  inspectedTasks: 0,
  firstPassTasks: 0,
  findingsHigh: 0,
};

/**
 * 施設ごとに月ぶんを足す。**純粋関数。**
 *
 * `openIssues` を足さないのは、あれが**日ごとの断面ではなく現在値**
 * だから（`schema/rollup.ts` の注記）。31 日ぶん足すと 31 倍になる。
 * 要対応の不具合件数は `buildActions()` が別に数える。
 */
export function foldRollupsByProperty(rows: readonly RollupRow[]): Map<string, RollupTotals> {
  const byProperty = new Map<string, RollupTotals>();
  for (const row of rows) {
    const acc = byProperty.get(row.propertyId) ?? { ...ZERO_TOTALS };
    acc.totalTasks += row.totalTasks;
    acc.completedTasks += row.completedTasks;
    acc.reworkTasks += row.reworkTasks;
    acc.totalMinutes += row.totalMinutes;
    acc.inspectedTasks += row.inspectedTasks;
    acc.firstPassTasks += row.firstPassTasks;
    acc.findingsHigh += row.findingsHigh;
    byProperty.set(row.propertyId, acc);
  }
  return byProperty;
}

/** 全施設ぶんを 1 つに畳む。**純粋関数。** */
export function sumTotals(values: Iterable<RollupTotals>): RollupTotals {
  const total = { ...ZERO_TOTALS };
  for (const row of values) {
    total.totalTasks += row.totalTasks;
    total.completedTasks += row.completedTasks;
    total.reworkTasks += row.reworkTasks;
    total.totalMinutes += row.totalMinutes;
    total.inspectedTasks += row.inspectedTasks;
    total.firstPassTasks += row.firstPassTasks;
    total.findingsHigh += row.findingsHigh;
  }
  return total;
}

/**
 * 保管期限が近い忘れ物か。**純粋関数。**
 *
 * 期限を過ぎたものも「近い」に含める。**過ぎた瞬間に一覧から消えると、
 * 対応漏れが見えなくなる**（§7.1 の要対応は「気づくため」の欄）。
 * 期限が未設定（`null`）のものは数えない — 判定する材料が無い。
 */
export function isLostItemExpiring(
  retentionDueAt: Date | null,
  now: Date,
  windowDays: number = LOST_ITEM_EXPIRY_WARNING_DAYS,
): boolean {
  if (retentionDueAt === null) return false;
  const remainingMs = retentionDueAt.getTime() - now.getTime();
  return remainingMs <= windowDays * 24 * 60 * 60 * 1000;
}

/** 保管中とみなす忘れ物の状態（返却・廃棄・移管が済んだものを除く）。 */
const HELD_LOST_ITEM_STATUSES = ["FOUND", "STORED", "REPORTED_TO_POLICE", "RETURN_PENDING"] as const;

/** 未解決とみなす設備不具合の状態。 */
const OPEN_ISSUE_STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"] as const;

/** 未締めとみなす請求期間の状態。**`INVOICED` / `CLOSED` は締まっている。** */
const UNCLOSED_PERIOD_STATUSES = ["OPEN", "REVIEWING", "AGREED"] as const;

/** 未対応とみなす差異の状態（§6.1）。 */
const OPEN_FINDING_STATUSES = ["OPEN", "REVIEWING"] as const;

/**
 * 要対応の 4 件を数える。
 *
 * **一覧を返さない**（`contracts/dashboard.ts` の注記）。件数だけを出し、
 * 「確認する」は既存の画面へ送る。
 */
export async function buildActions(
  env: Env,
  ctx: TenantContext,
): Promise<OrgDashboardActions> {
  const [findingCounts, issues, lostItems, periods] = await Promise.all([
    // 差異は**期間で絞らない。** 先月に出た未対応の差異が消えてはいけない。
    countFindingsByStatus(env, ctx, {}),
    listIssueReports(env, ctx, { status: [...OPEN_ISSUE_STATUSES] }),
    listLostItems(env, ctx, { status: [...HELD_LOST_ITEM_STATUSES] }),
    listBillingPeriods(env, ctx, { status: [...UNCLOSED_PERIOD_STATUSES] }),
  ]);

  const openFindings = OPEN_FINDING_STATUSES.reduce(
    (sum, status) => sum + (findingCounts.get(status) ?? 0),
    0,
  );

  return {
    openFindings,
    openIssues: issues.length,
    expiringLostItems: lostItems.filter((row) => isLostItemExpiring(row.retentionDueAt, ctx.now))
      .length,
    unclosedBillingPeriods: periods.length,
  };
}

/**
 * 組織ダッシュボード 1 画面ぶん。
 *
 * ── キャッシュを置いていない ────────────────────────────
 * 施設セレクタ（§23.3）は開くたびに走るので 60 秒キャッシュを置いた
 * （`lib/property/summary.ts`）。こちらは月次で、**開くのは 1 日に数回。**
 * 数字が古いまま見えるほうが害が大きい（要対応の件数が減らない）。
 */
export async function buildOrgDashboard(
  env: Env,
  ctx: TenantContext,
  month: string,
): Promise<OrgDashboardResponse> {
  // `monthSchema` を通った値しか来ないので `null` にはならない。
  // それでも既定を置くのは、型を満たすために `!` を使わないため。
  const range = monthRangeOf(month) ?? { from: `${month}-01`, to: `${month}-28` };

  const [properties, rollups, roomCounts, costs, actions] = await Promise.all([
    listSelectableProperties(env, ctx),
    listRollupsInRange(env, ctx, range),
    countSellableRoomsByProperty(env, ctx),
    sumInvoiceLineAmountsByProperty(env, ctx, range),
    buildActions(env, ctx),
  ]);

  const byProperty = foldRollupsByProperty(rollups);

  const rows: OrgDashboardProperty[] = properties.map((property) => {
    const totals = byProperty.get(property.id) ?? { ...ZERO_TOTALS };
    return {
      propertyId: property.id,
      code: property.code,
      name: property.name,
      roomCount: roomCounts.get(property.id) ?? 0,
      ...totals,
      // **`undefined` を 0 に倒さない。** 請求書がまだ無い月と
      // 無償だった月を同じ数字にしない（`contracts/dashboard.ts`）。
      cleaningCost: costs.get(property.id) ?? null,
    };
  });

  const totals = sumTotals(rows);
  // 全社の費用は**施設別が 1 つでも出ていれば合計する。** 全部 `null`
  // （その月の請求書が 1 枚も無い）のときだけ `null`。
  const costValues = rows.map((row) => row.cleaningCost).filter((value) => value !== null);

  const summary: OrgDashboardSummary = {
    propertyCount: rows.length,
    roomCount: rows.reduce((sum, row) => sum + row.roomCount, 0),
    ...totals,
    cleaningCost: costValues.length === 0 ? null : costValues.reduce((sum, v) => sum + v, 0),
  };

  return {
    month,
    from: range.from,
    to: range.to,
    hasRollup: rollups.length > 0,
    summary,
    properties: rows,
    actions,
  };
}
