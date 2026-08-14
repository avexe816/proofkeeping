/**
 * 集計と明細の組み立て（PK-SPEC-P5 §3）。**純粋関数。**
 *
 * task:  docs/tasks/P5-04.md
 * ルール: .claude/rules/billing.md §4・§8 / testing.md §3
 *
 * ── 黙って落とさない（§3.2 MUST / billing.md §8）─────────
 * **料金が決まっていないタスクを請求から除外しない。**
 * `unitPrice = 0` の明細として計上し、`unpriced` に理由を残す。
 * 画面（P5-05 / P5-07）はそれを警告として出す。
 *
 * 「除外」と「0 円で計上」は結果が同じに見えるが違う。除外すると
 * **請求書の合計だけを見ても抜けに気づけない。** 0 円の行なら目に入る。
 *
 * ── 明細の粒度は 施設 × 清掃種別 × 客室タイプ（§3.4）────
 * 客室単位の明細は取引先ごとの設定で「別紙」として付ける（§3.4）。
 * **既定の明細に 1 室ずつ並べない**（100 室の施設で 100 行になる）。
 *
 * ── DB・fetch・現在時刻を持ち込まない ───────────────────
 * CLAUDE.md §5。入力はすべて呼び出し側が集めた事実。
 */

import { resolvePricing, type PricingRuleFact } from "./pricing.js";
import { calculateTax, lineAmount, type TaxRoundingMode, type TaxTotals } from "./tax.js";

/**
 * 集計対象のタスク 1 件（§3.1）。
 *
 * **除外の判定は呼び出し側。** §3.1 は `COMPLETED` だけを対象とし、
 * `CANCELLED` / `BLOCKED` のまま終わったものと、有償設定でない再清掃を
 * 外すと定める。ここへ来るのは既に絞られたタスク。
 */
export interface BillableTask {
  taskId: string;
  propertyId: string;
  propertyName: string;
  roomTypeId: string | null;
  roomTypeName: string | null;
  taskType: string;
  /** 請求の品目（§2.4）。作業種別との対応は呼び出し側が決める。 */
  itemCode: string;
  /** 役務提供日（`YYYY-MM-DD`）。 */
  serviceDate: string;
  /** 数量。**通常は 1 室 = 1**（§2.4 の `quantity` は `real`）。 */
  quantity: number;
}

/** 料金が決まっていなかった組（§3.2 MUST の警告）。 */
export interface UnpricedGroup {
  propertyId: string;
  propertyName: string;
  roomTypeId: string | null;
  taskType: string;
  itemCode: string;
  /** 何件が 0 円で計上されたか。 */
  taskCount: number;
}

/** 組み立てた明細 1 行（`invoiceLine` の元）。 */
export interface AggregatedLine {
  lineNo: number;
  propertyId: string;
  itemCode: string;
  description: string;
  serviceDateFrom: string;
  serviceDateTo: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  taxRate: number;
  isReducedRate: boolean;
  /** 集計元のタスク（§6.3 のドリルダウン / P5-13）。 */
  sourceTaskIds: string[];
  /** **料金が決まっていなかった行。** 画面が警告を出す目印。 */
  isUnpriced: boolean;
}

/** `aggregateInvoiceLines()` の結果。 */
export interface AggregationResult {
  lines: AggregatedLine[];
  totals: TaxTotals;
  /** **空でなければ画面に警告を出す**（§3.2 MUST）。 */
  unpriced: UnpricedGroup[];
}

/** 料金が無かったときに使う既定（§3.2 MUST）。**0 円で計上する。** */
export const UNPRICED_UNIT_PRICE = 0;

/**
 * 料金が無いときの税率。
 *
 * **10% を当てる。** 0 円なので税額も 0 になり、どの税率でも合計は変わらない。
 * 税区分サマリー（§2.5）に空の区分を増やさないよう、標準税率の側へ寄せる。
 */
export const UNPRICED_TAX_RATE = 10;

/** 既定の単位（§2.4）。 */
export const DEFAULT_UNIT = "室";

/** 組の鍵（§3.4 の「施設 × 清掃種別 × 客室タイプ」）。 */
function groupKeyOf(task: BillableTask): string {
  return [task.propertyId, task.itemCode, task.taskType, task.roomTypeId ?? ""].join("|");
}

/**
 * 明細の説明文（§3.4 の例「サンプルホテル東京 / アウト清掃 / シングル」）。
 *
 * **語彙を作らない。** 施設名と客室タイプ名はそのまま、作業の呼び名は
 * 呼び出し側が渡した `itemLabel` を使う（帳票の文言は `packages/pdf` の
 * `labels.ts` が持つ / ui-writing.md §1 の対象外）。
 */
export function describeLine(input: {
  propertyName: string;
  itemLabel: string;
  roomTypeName: string | null;
}): string {
  const parts = [input.propertyName, input.itemLabel];
  if (input.roomTypeName !== null && input.roomTypeName !== "") parts.push(input.roomTypeName);
  return parts.join(" / ");
}

/**
 * タスクを明細へ畳む（§3.3・§3.4）。
 *
 * **決定性がある。** 組の並びは施設 → 品目 → 作業種別 → 客室タイプの
 * 辞書順で固定するので、同じ入力からは同じ請求書ができる（§4.3 の冪等性）。
 *
 * @param itemLabelOf 品目コード → 表示名。**engine が語彙を持たない。**
 */
export function aggregateInvoiceLines(input: {
  tasks: readonly BillableTask[];
  pricingRules: readonly PricingRuleFact[];
  taxRoundingMode: TaxRoundingMode;
  itemLabelOf: (itemCode: string) => string;
}): AggregationResult {
  const groups = new Map<string, BillableTask[]>();
  for (const task of input.tasks) {
    const key = groupKeyOf(task);
    const bucket = groups.get(key) ?? [];
    bucket.push(task);
    groups.set(key, bucket);
  }

  const keys = [...groups.keys()].sort();
  const lines: AggregatedLine[] = [];
  const unpriced: UnpricedGroup[] = [];

  for (const key of keys) {
    const tasks = groups.get(key) ?? [];
    const head = tasks[0];
    if (head === undefined) continue;

    const dates = tasks.map((task) => task.serviceDate).sort();
    // **役務提供日は組の中で最も早い日〜最も遅い日。** 期間で持つのは
    // §2.4 が `serviceDateFrom` / `serviceDateTo` を分けているため。
    const serviceDateFrom = dates[0] ?? head.serviceDate;
    const serviceDateTo = dates[dates.length - 1] ?? head.serviceDate;

    const resolved = resolvePricing(input.pricingRules, {
      propertyId: head.propertyId,
      roomTypeId: head.roomTypeId,
      taskType: head.taskType,
      itemCode: head.itemCode,
      // **組の最初の役務提供日で引く。** 期間の途中で値上げがあった場合は
      // 組が分かれないので最初の日の単価になる。締めは 1 か月なので、
      // 月内の値上げは締め日を分けて運用する（§2.8 の `billingPeriod`）。
      serviceDate: serviceDateFrom,
    });

    const quantity = tasks.reduce((total, task) => total + task.quantity, 0);
    const unitPrice = resolved?.rule.unitPrice ?? UNPRICED_UNIT_PRICE;
    const taxRate = resolved?.rule.taxRate ?? UNPRICED_TAX_RATE;
    const isReducedRate = resolved?.rule.isReducedRate ?? false;

    if (resolved === null) {
      // §3.2 MUST。**除外せずに 0 円で計上し、警告に残す。**
      unpriced.push({
        propertyId: head.propertyId,
        propertyName: head.propertyName,
        roomTypeId: head.roomTypeId,
        taskType: head.taskType,
        itemCode: head.itemCode,
        taskCount: tasks.length,
      });
    }

    lines.push({
      lineNo: lines.length + 1,
      propertyId: head.propertyId,
      itemCode: head.itemCode,
      description: describeLine({
        propertyName: head.propertyName,
        itemLabel: input.itemLabelOf(head.itemCode),
        roomTypeName: head.roomTypeName,
      }),
      serviceDateFrom,
      serviceDateTo,
      quantity,
      unit: DEFAULT_UNIT,
      unitPrice,
      amount: lineAmount(quantity, unitPrice),
      taxRate,
      isReducedRate,
      // **並びを固定する**（§4.3 の冪等性。同じ請求書を 2 回作っても同じ）。
      sourceTaskIds: tasks.map((task) => task.taskId).sort(),
      isUnpriced: resolved === null,
    });
  }

  return {
    lines,
    totals: calculateTax(lines, input.taxRoundingMode),
    unpriced,
  };
}
