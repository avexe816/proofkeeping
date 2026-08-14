/**
 * 清掃会社プランの組み立て（PK-SPEC-P5 §7.2）。
 *
 * task:  docs/tasks/P5-15.md
 * ルール: .claude/rules/architecture.md §3 / .claude/rules/billing.md §4 /
 *        .claude/rules/security.md §5
 *
 * ── 稼働の数字は rollup だけ（§7.1 MUST を §7.2 にも掛ける）─
 * §7.2 に MUST の文言は無いが、実績も実働時間も**同じ集計テーブル**の
 * 同じ列であり、ここだけタスクテーブルを直接集計する理由が無い。
 * `lib/dashboard/org.ts` の `foldRollupsByProperty()` / `sumTotals()` を
 * そのまま使う。**同じ畳み込みを 2 つ置かない。**
 *
 * ── 金額の出どころは 3 つに分かれる ─────────────────────
 *   ① 請求状況の金額（税込）…… `invoice.totalAmount`。無ければ
 *      双方合意の履歴に残る写し（`findLatestReviewSnapshotTotals()`）
 *   ② 施設別収支の請求額（税抜）…… `invoice_line.amount` を施設で畳む
 *      （`sumInvoiceLineAmountsByProperty()` / P5-14 と同じ関数）
 *   ③ 売上合計・未回収（税込）…… ① の請求書を足す
 *
 * **どれも rollup には無い**（DECISIONS #132）。金額の正を集計テーブルへ
 * 二重化しない。
 *
 * ── 人を数えるが、人を並べない ──────────────────────────
 * 「稼働スタッフ 34名」は `countActiveMembershipsByRole()` の合計。
 * 個人の一覧も、個人ごとの実績も**この画面に持ち込まない**
 * （security.md §5 / ui-writing.md §3）。
 *
 * ── 施設をまたぐ JOIN を書かない ────────────────────────
 * 読むのは独立したクエリで、突き合わせは JS の `Map`（§7.1 と同じ）。
 */

import {
  countActiveMembershipsByRole,
  findLatestReviewSnapshotTotals,
  listBillingPeriods,
  listCounterparties,
  listInvoices,
  listRollupsInRange,
  sumInvoiceLineAmountsByProperty,
  type Env,
  type TenantContext,
} from "@pk/db";
import type {
  VendorBillingRow,
  VendorBillingState,
  VendorPlanResponse,
  VendorPlanSummary,
  VendorPropertyRow,
} from "@pk/contracts";

import { listSelectableProperties } from "../property/selection.js";

import { foldRollupsByProperty, monthRangeOf } from "./org.js";

/**
 * 「稼働スタッフ」に数えるロール。
 *
 * 現場に出るロール（security.md §2 の「現場系」）と、その現場を持つ
 * 施設責任者まで。`OWNER` / `ORG_ADMIN` / `AUDITOR` / `VENDOR_ADMIN` は
 * 事務・監査の側で、**清掃の稼働人数ではない。**
 */
const FIELD_ROLES = ["PROPERTY_MANAGER", "INSPECTOR", "CLEANER"] as const;

/** 請求状況に載せる締めの状態（`INVOICED` / `CLOSED` は請求書側が語る）。 */
const PENDING_PERIOD_STATUSES = ["OPEN", "REVIEWING", "AGREED"] as const;

/** 締めの状態 → 表示の状態。**請求書がまだ無い期間だけが通る。** */
const STATE_BY_PERIOD_STATUS = {
  OPEN: "AGGREGATING",
  REVIEWING: "REVIEWING",
  AGREED: "AGREED",
} as const satisfies Record<(typeof PENDING_PERIOD_STATUSES)[number], VendorBillingState>;

/**
 * 請求書の状態 → 表示の状態。**純粋関数。**
 *
 * `DRAFT` を `AGGREGATING` に落とすのは、下書きが「まだ動く数字」だから。
 * §2.5 の `PARTIALLY_PAID` はここに来ない（入金は全額のみ /
 * docs/OPEN_QUESTIONS.md #076）。来た場合も未入金として扱う — 一部でも
 * 残っている以上、清掃会社が追うべき相手であることは変わらない。
 */
export function billingStateOfInvoice(status: string): VendorBillingState {
  switch (status) {
    case "PAID":
      return "PAID";
    case "OVERDUE":
      return "OVERDUE";
    case "VOIDED":
      return "VOIDED";
    case "SENT":
    case "VIEWED":
      return "SENT";
    case "CONFIRMED":
      return "ISSUED";
    default:
      return "AGGREGATING";
  }
}

/**
 * 「← 要対応」を出すか（§7.2 の見本）。**純粋関数。**
 *
 * ── 集計中に印を付けない ────────────────────────────────
 * 見本で印が付くのは合意待ちの 1 行だけ。集計中は月の途中なら当たり前の
 * 状態で、そこに印を付けると**毎月ほぼ全行が要対応になり、印が意味を失う。**
 *
 * `REVIEWING` は相手の返事を待っている状態で、放っておくと止まったままに
 * なる。`OVERDUE` は期限を過ぎた未入金。どちらも**清掃会社が誰かに
 * 声を掛けないと動かない。**
 */
export function needsActionOf(state: VendorBillingState): boolean {
  return state === "REVIEWING" || state === "OVERDUE";
}

/** 請求状況の 1 行を組み立てるための素。 */
interface BillingSource {
  counterpartyId: string;
  periodFrom: string;
  periodTo: string;
  billingPeriodId: string | null;
  /** 締めの状態。請求書だけがある場合は `null`。 */
  periodStatus: "OPEN" | "REVIEWING" | "AGREED" | null;
  invoice: { id: string; status: string; totalAmount: number; counterpartyName: string } | null;
  /** 双方合意の履歴に残る最後の写し（税込）。 */
  snapshotTotal: number | null;
}

/**
 * 請求状況の 1 行。**純粋関数。**
 *
 * 請求書があればそちらが正（金額も名前も帳票のもの / billing.md §6）。
 * 無ければ締めの状態と、最後に見せた明細の写しで埋める。
 */
export function buildBillingRow(source: BillingSource, fallbackName: string): VendorBillingRow {
  const state: VendorBillingState =
    source.invoice !== null
      ? billingStateOfInvoice(source.invoice.status)
      : STATE_BY_PERIOD_STATUS[source.periodStatus ?? "OPEN"];

  const amount = source.invoice?.totalAmount ?? source.snapshotTotal ?? null;

  return {
    counterpartyId: source.counterpartyId,
    counterpartyName: source.invoice?.counterpartyName ?? fallbackName,
    periodFrom: source.periodFrom,
    periodTo: source.periodTo,
    amount,
    isConfirmedAmount: source.invoice !== null,
    state,
    needsAction: needsActionOf(state),
    billingPeriodId: source.billingPeriodId,
    invoiceId: source.invoice?.id ?? null,
  };
}

/**
 * 売上合計と未回収（税込）。**純粋関数。**
 *
 * ── 数えるのは確定した請求書だけ ────────────────────────
 * 合意の途中で見せた写し（`isConfirmedAmount = false`）を売上に足さない。
 * 見せただけの数字が売上に乗ると、**まだ請求していない額を売上として
 * 報告する**ことになる。取り消した請求書（`VOIDED`）も除く。
 *
 * ── 未回収は「入金済でないもの」 ────────────────────────
 * 一部入金を表せない以上（OPEN_QUESTIONS #076）、`PAID` 以外は全額が
 * 未回収。**送付前（`ISSUED`）も未回収に含める** — 相手にまだ届いて
 * いないだけで、回収できていないことに変わりはない。
 *
 * 確定した請求書が 1 枚も無ければ両方 `null`。**0 円ではない。**
 */
export function sumSales(rows: readonly VendorBillingRow[]): {
  salesTotal: number | null;
  unpaidTotal: number | null;
} {
  const confirmed = rows.filter(
    (row) => row.isConfirmedAmount && row.state !== "VOIDED" && row.amount !== null,
  );
  if (confirmed.length === 0) return { salesTotal: null, unpaidTotal: null };

  let salesTotal = 0;
  let unpaidTotal = 0;
  for (const row of confirmed) {
    const amount = row.amount ?? 0;
    salesTotal += amount;
    if (row.state !== "PAID") unpaidTotal += amount;
  }
  return { salesTotal, unpaidTotal };
}

/**
 * 全社の時間単価の分子と分母（§7.2 MUST の「組織平均」）。**純粋関数。**
 *
 * ── 施設の単価を平均しない ──────────────────────────────
 * 施設ごとの単価を足して施設数で割ると、**1 か月に 20 件しか無い施設が、
 * 1,400 件の施設と同じ重みで平均を動かす。** 「組織平均の時間単価」は
 * 全社の請求額 ÷ 全社の実働時間で、加重平均になる。
 *
 * 請求額が `null` の施設は分子にも分母にも入れない。**金額が分からない
 * 施設の実働時間だけを分母に足すと、平均が不当に下がる。**
 */
export function averageRateBasis(rows: readonly VendorPropertyRow[]): {
  billedAmount: number | null;
  totalMinutes: number;
} {
  let billedAmount = 0;
  let totalMinutes = 0;
  let counted = 0;
  for (const row of rows) {
    if (row.billedAmount === null) continue;
    billedAmount += row.billedAmount;
    totalMinutes += row.totalMinutes;
    counted += 1;
  }
  return counted === 0 ? { billedAmount: null, totalMinutes: 0 } : { billedAmount, totalMinutes };
}

/**
 * 清掃会社プラン 1 画面ぶん（§7.2）。
 *
 * §7.1 と同じくキャッシュを置いていない（`buildOrgDashboard()` の注記）。
 */
export async function buildVendorPlan(
  env: Env,
  ctx: TenantContext,
  month: string,
): Promise<VendorPlanResponse> {
  // `monthSchema` を通った値しか来ない（`buildOrgDashboard()` と同じ）。
  const range = monthRangeOf(month) ?? { from: `${month}-01`, to: `${month}-28` };

  const [properties, rollups, costs, roles, counterparties, invoices, periods] = await Promise.all([
    listSelectableProperties(env, ctx),
    listRollupsInRange(env, ctx, range),
    sumInvoiceLineAmountsByProperty(env, ctx, range),
    countActiveMembershipsByRole(env, ctx),
    listCounterparties(env, ctx, { isActive: true }),
    listInvoices(env, ctx, { periodOverlapFrom: range.from, periodOverlapTo: range.to }),
    listBillingPeriods(env, ctx, {
      status: [...PENDING_PERIOD_STATUSES],
      periodToFrom: range.from,
      periodFromTo: range.to,
    }),
  ]);

  // 締めの写しは、請求書がまだ無い期間ぶんだけ引く。**全期間ぶん読まない。**
  const invoiceByPeriodKey = new Map(
    invoices.map((row) => [`${row.counterpartyId} ${row.periodFrom} ${row.periodTo}`, row]),
  );
  const pendingPeriods = periods.filter(
    (row) =>
      !invoiceByPeriodKey.has(`${row.counterpartyId} ${row.periodFrom} ${row.periodTo}`),
  );
  const snapshots = await findLatestReviewSnapshotTotals(
    env,
    ctx,
    pendingPeriods.map((row) => row.id),
  );

  const nameById = new Map(
    counterparties.map((row) => [row.id, row.displayName ?? row.legalName]),
  );

  // 請求書のある期間と、まだ無い期間。**同じ取引先で 2 行にしない。**
  const sources: BillingSource[] = [
    ...invoices.map((row) => ({
      counterpartyId: row.counterpartyId,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      billingPeriodId:
        periods.find(
          (period) =>
            period.counterpartyId === row.counterpartyId &&
            period.periodFrom === row.periodFrom &&
            period.periodTo === row.periodTo,
        )?.id ?? null,
      periodStatus: null,
      invoice: {
        id: row.id,
        status: row.status,
        totalAmount: row.totalAmount,
        counterpartyName: row.counterpartyName,
      },
      snapshotTotal: null,
    })),
    ...pendingPeriods.map((row) => ({
      counterpartyId: row.counterpartyId,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      billingPeriodId: row.id,
      periodStatus: row.status as "OPEN" | "REVIEWING" | "AGREED",
      invoice: null,
      snapshotTotal: snapshots.get(row.id) ?? null,
    })),
  ];

  const billing = sources
    .map((source) => buildBillingRow(source, nameById.get(source.counterpartyId) ?? "—"))
    .sort(
      (a, b) =>
        b.periodTo.localeCompare(a.periodTo) || a.counterpartyName.localeCompare(b.counterpartyName, "ja"),
    );

  const byProperty = foldRollupsByProperty(rollups);
  const propertyRows: VendorPropertyRow[] = properties.map((property) => {
    const totals = byProperty.get(property.id);
    return {
      propertyId: property.id,
      code: property.code,
      name: property.name,
      totalTasks: totals?.totalTasks ?? 0,
      totalMinutes: totals?.totalMinutes ?? 0,
      // **`undefined` を 0 に倒さない**（`buildOrgDashboard()` と同じ）。
      billedAmount: costs.get(property.id) ?? null,
    };
  });

  const summary: VendorPlanSummary = {
    propertyCount: propertyRows.length,
    staffCount: FIELD_ROLES.reduce((sum, role) => sum + (roles.get(role) ?? 0), 0),
    // **表に出ている施設だけを足す**（`buildOrgDashboard()` と同じ）。
    // 上の数字と下の表が食い違うほうが、集計として害が大きい。
    totalTasks: propertyRows.reduce((sum, row) => sum + row.totalTasks, 0),
    ...sumSales(billing),
  };

  return {
    month,
    from: range.from,
    to: range.to,
    hasRollup: rollups.length > 0,
    summary,
    billing,
    properties: propertyRows,
  };
}
