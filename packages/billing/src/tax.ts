/**
 * 税額の計算（PK-SPEC-P5 §3.3 / billing.md §4）。**純粋関数。**
 *
 * task:  docs/tasks/P5-04.md
 * ルール: .claude/rules/billing.md §4
 *
 * ── 浮動小数点を使わない（billing.md §4 MUST）───────────
 * 金額はすべて整数（円）。`0.1 + 0.2 !== 0.3` の世界に消費税を持ち込むと、
 * 1 円の食い違いが取引先との照合で表面化する。
 * **このファイルに `/` を書くときは必ず `Math.floor` 等で閉じること。**
 *
 * ── 端数処理は税率ごとに 1 回だけ（§2.5 MUST / §3.3）───
 * ```
 * ① 明細の amount = quantity × unitPrice（整数演算）
 * ② 税率ごとに subtotal を合計
 * ③ 税率ごとに tax = subtotal × rate / 100 を 1 回だけ端数処理
 * ```
 * **明細行ごとに端数処理しない。** 行ごとに丸めると、100 行で最大 100 円
 * ずれる。`invoiceLine` に税額の列を持たせていないのはこのため。
 *
 * ── `quantity` だけが小数 ───────────────────────────────
 * §2.4 は `quantity` を `real` にしている（0.5 室のような数え方）。
 * `amount` は整数なので、掛けた時点で丸める。**丸め方は切り捨て**
 * （数量の端数で単価を上回らない側）。
 */

/** 端数処理の方式（billing.md §4 / `counterparty.taxRoundingMode`）。 */
export const TAX_ROUNDING_MODES = ["FLOOR", "CEIL", "ROUND"] as const;

export type TaxRoundingMode = (typeof TAX_ROUNDING_MODES)[number];

/**
 * 端数を処理する。**整数を返す。**
 *
 * `ROUND` は四捨五入（`Math.round`）。**負の値でも同じ向きに丸める**
 * ように、絶対値で丸めてから符号を戻す。赤伝（マイナス伝票 / §5）が
 * あるので負の金額は現実に出る。`Math.round(-0.5)` が `-0` になる
 * JavaScript の既定のままだと、赤伝と元の伝票で 1 円ずれうる。
 */
export function applyRounding(value: number, mode: TaxRoundingMode): number {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const rounded =
    mode === "FLOOR"
      ? Math.floor(magnitude)
      : mode === "CEIL"
        ? Math.ceil(magnitude)
        : Math.round(magnitude);
  return sign * rounded;
}

/**
 * 明細 1 行の金額（§3.3 の手順①）。
 *
 * `quantity × unitPrice` を**整数へ落とす。** 数量が小数のときは
 * 切り捨て（`applyRounding` の `FLOOR`）。
 * **ここで税を掛けない。** 税は税率ごとに 1 回（手順③）。
 */
export function lineAmount(quantity: number, unitPrice: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return 0;
  return applyRounding(quantity * unitPrice, "FLOOR");
}

/** 税額の計算に渡す明細 1 行。 */
export interface TaxableLine {
  amount: number;
  /** 百分率の整数（10 / 8）。 */
  taxRate: number;
  isReducedRate: boolean;
}

/** 税率ごとの内訳（`invoiceTaxSummary` の 1 行 / §2.5）。 */
export interface TaxSummaryLine {
  taxRate: number;
  isReducedRate: boolean;
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/** 請求全体の合計（§2.3 の `subtotalAmount` / `taxAmount` / `totalAmount`）。 */
export interface TaxTotals {
  summaries: TaxSummaryLine[];
  subtotalAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/**
 * 税率ごとに 1 回だけ端数処理して合計を出す（§3.3 MUST）。
 *
 * ── 区分は「税率 × 軽減税率か」の組 ────────────────────
 * `invoiceTaxSummary` の一意キーが `(invoiceId, taxRate, isReducedRate)`
 * なので、同じ 8% でも軽減税率の 8% と経過措置の 8% は別の行になる。
 * **税率だけで畳まないこと。**
 *
 * ── 並びは税率の高い順 ──────────────────────────────────
 * 請求書に出る順（§8.1 の様式）。決定性のためでもある。
 */
export function calculateTax(
  lines: readonly TaxableLine[],
  mode: TaxRoundingMode,
): TaxTotals {
  // ② 税率ごとに subtotal を合計する。**ここではまだ丸めない。**
  const buckets = new Map<string, { taxRate: number; isReducedRate: boolean; subtotal: number }>();
  for (const line of lines) {
    const key = `${String(line.taxRate)}|${String(line.isReducedRate)}`;
    const bucket = buckets.get(key) ?? {
      taxRate: line.taxRate,
      isReducedRate: line.isReducedRate,
      subtotal: 0,
    };
    bucket.subtotal += line.amount;
    buckets.set(key, bucket);
  }

  const summaries: TaxSummaryLine[] = [...buckets.values()]
    .map((bucket) => {
      // ③ 税率ごとに 1 回だけ端数処理する（§3.3 MUST）。
      const taxAmount = applyRounding((bucket.subtotal * bucket.taxRate) / 100, mode);
      return {
        taxRate: bucket.taxRate,
        isReducedRate: bucket.isReducedRate,
        subtotalAmount: bucket.subtotal,
        taxAmount,
        totalAmount: bucket.subtotal + taxAmount,
      };
    })
    .sort((a, b) => {
      if (a.taxRate !== b.taxRate) return b.taxRate - a.taxRate;
      // 同じ税率なら軽減税率でないほうを先に（標準 → 軽減の順）。
      return Number(a.isReducedRate) - Number(b.isReducedRate);
    });

  return {
    summaries,
    subtotalAmount: summaries.reduce((total, row) => total + row.subtotalAmount, 0),
    taxAmount: summaries.reduce((total, row) => total + row.taxAmount, 0),
    totalAmount: summaries.reduce((total, row) => total + row.totalAmount, 0),
  };
}
