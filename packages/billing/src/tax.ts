/**
 * 消費税の計算（PK-SPEC-P5 §3.3 / .claude/rules/billing.md §4）。
 *
 * task: docs/tasks/P5-04.md
 *
 * ── MUST が 2 つ ────────────────────────────────────────
 * ① **浮動小数点で金額を扱わない。** すべて整数（円）。
 * ② **端数処理は税率ごとに 1 回だけ。** 明細行ごとに端数処理しない
 *    （§2.5 MUST）。だから `invoiceLine` に税額の列が無く、
 *    `invoiceTaxSummary` が「1 回」の置き場所になっている。
 *
 * ── 割り算をどう書いているか ────────────────────────────
 * `subtotal × rate` は整数。これを 100 で割るときに
 * `(n - (n % 100)) / 100` の形にしてある。割られる数が 100 の倍数なら
 * IEEE754 でも誤差なく割れるので、**商は必ず整数になる。**
 * `Math.floor(n / 100)` と結果は同じだが、途中に非整数を作らない。
 *
 * ── 赤伝で符号が割れないようにする ──────────────────────
 * 訂正は赤伝（マイナス伝票）＋再発行（§5）。`Math.floor(-1234.5)` は
 * -1235 で、元伝票の -(1234) と 1 円ずれる。**絶対値を丸めてから
 * 符号を戻す**ことで、赤伝の税額が元伝票の符号違いにちょうど一致する。
 * ずれると「訂正したのに 1 円残る」請求書ができる。
 */

import type { TaxRoundingModeValue } from "./vocabulary.js";

/** 100 円あたりの分母。税率は百分率の整数（10 / 8）で持つ。 */
const PERCENT = 100;

/**
 * 税率ごとの小計から税額を出す。**この関数が「1 回だけ」の端数処理。**
 *
 * @param subtotalAmount 税抜の合計（整数・円）。赤伝では負。
 * @param taxRate 百分率の整数（10 / 8）。
 */
export function calcTaxAmount(
  subtotalAmount: number,
  taxRate: number,
  mode: TaxRoundingModeValue,
): number {
  const sign = subtotalAmount < 0 ? -1 : 1;
  const scaled = Math.abs(subtotalAmount) * taxRate;
  const remainder = scaled % PERCENT;
  const quotient = (scaled - remainder) / PERCENT;

  const rounded =
    mode === "FLOOR"
      ? quotient
      : mode === "CEIL"
        ? remainder === 0
          ? quotient
          : quotient + 1
        : // ROUND は四捨五入。0.5 円は切り上げ。
          remainder >= PERCENT / 2
          ? quotient + 1
          : quotient;

  return sign * rounded;
}

/** 税区分の鍵。**税率と軽減税率の別で分ける**（§2.5 の `uq_tax_sum`）。 */
export interface TaxBucketKey {
  taxRate: number;
  isReducedRate: boolean;
}

/** 税額の計算に載せる 1 行（明細の部分集合）。 */
export interface TaxableLine extends TaxBucketKey {
  /** 税抜の金額（整数・円）。 */
  amount: number;
}

/** 税区分サマリー 1 行（§2.5）。 */
export interface TaxSummaryEntry extends TaxBucketKey {
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
}

function bucketKeyOf(line: TaxBucketKey): string {
  return `${String(line.taxRate)}:${line.isReducedRate ? "R" : "S"}`;
}

/**
 * 明細を税率ごとにまとめ、税率ごとに 1 回だけ端数処理する（§3.3）。
 *
 * **税率の高い順**に返す。§8.1 の請求書 PDF が「10% 対象 … 8% 対象 …」の
 * 順で並べるため（`listInvoiceTaxSummaries()` の並びと揃えてある）。
 */
export function summarizeTax(
  lines: readonly TaxableLine[],
  mode: TaxRoundingModeValue,
): TaxSummaryEntry[] {
  const buckets = new Map<string, { key: TaxBucketKey; subtotal: number }>();

  for (const line of lines) {
    const key = bucketKeyOf(line);
    const found = buckets.get(key);
    if (found === undefined) {
      buckets.set(key, {
        key: { taxRate: line.taxRate, isReducedRate: line.isReducedRate },
        subtotal: line.amount,
      });
    } else {
      found.subtotal += line.amount;
    }
  }

  return [...buckets.values()]
    .map(({ key, subtotal }) => {
      const taxAmount = calcTaxAmount(subtotal, key.taxRate, mode);
      return {
        taxRate: key.taxRate,
        isReducedRate: key.isReducedRate,
        subtotalAmount: subtotal,
        taxAmount,
        totalAmount: subtotal + taxAmount,
      };
    })
    .sort(compareTaxSummary);
}

/** 税率の高い順。同率なら標準税率が先（軽減が後）。 */
function compareTaxSummary(a: TaxSummaryEntry, b: TaxSummaryEntry): number {
  if (a.taxRate !== b.taxRate) return b.taxRate - a.taxRate;
  return Number(a.isReducedRate) - Number(b.isReducedRate);
}

/**
 * 明細行の金額。`amount = quantity × unitPrice`（§3.3 の手順 1）。
 *
 * `quantity` は `real`（0.5 室のような数え方がありうる / §2.4）。
 * **積は整数へ落とす。** 円未満の金額は存在しない。端数の向きは
 * 取引先の端数処理方式に合わせる（税額と別方式にする根拠が無い）。
 */
export function calcLineAmount(
  quantity: number,
  unitPrice: number,
  mode: TaxRoundingModeValue,
): number {
  if (Number.isInteger(quantity)) return quantity * unitPrice;

  const sign = quantity * unitPrice < 0 ? -1 : 1;
  const scaled = Math.abs(quantity * unitPrice);
  const floor = Math.floor(scaled);
  const hasFraction = floor !== scaled;

  const rounded =
    mode === "FLOOR"
      ? floor
      : mode === "CEIL"
        ? hasFraction
          ? floor + 1
          : floor
        : Math.round(scaled);

  return sign * rounded;
}
