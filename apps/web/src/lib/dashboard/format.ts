/**
 * 組織ダッシュボードの表示計算（W-02 / PK-SPEC-P5 §7.1）。
 *
 * task: docs/tasks/P5-14.md
 *
 * **すべて純粋関数。** API は分子と分母を整数で返し、割るのはここ
 * （`packages/contracts/src/dashboard.ts` の注記）。
 *
 * ── 分母 0 を 0% と書かない ─────────────────────────────
 * 清掃が 1 件も無い月の完了率は 0% ではなく「無い」。0% と出すと、
 * **全部やり残したように読める。** `null` を返し、画面が「—」を描く。
 *
 * ── 金額は整数のまま扱う ────────────────────────────────
 * 1 室あたり原価だけは割り算になる。**切り捨てて整数（円）にする**
 * （billing.md §4「金額計算に浮動小数点を使わない」）。表示のための
 * 数字であって請求に使わないが、円未満を持ち回る形を作らない。
 */

/** 分母 0 を弾く割り算。**割合（0〜100）ではなく比を返す。** */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * 割合を「98.2%」の形にする。分母 0 なら `null`。
 *
 * 小数第 1 位まで。**四捨五入する**（§7.1 の見本が 98.2% と 91.4%）。
 */
export function formatPercent(numerator: number, denominator: number): string | null {
  const value = ratio(numerator, denominator);
  if (value === null) return null;
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * 平均清掃時間を「28.3」にする。分母 0 なら `null`。
 *
 * 分母は**完了したタスク**（`totalMinutes` が完了ぶんの合計なので）。
 *
 * **単位を付けない。** 「分」は文言カタログの側（`t()`）に置く。
 * `t()` は補間を持たない設計なので、数字と単位は別の要素として組む
 * （`lib/i18n.ts` の注記）。
 */
export function formatAverageMinutes(totalMinutes: number, completedTasks: number): string | null {
  const value = ratio(totalMinutes, completedTasks);
  if (value === null) return null;
  return value.toFixed(1);
}

/**
 * 1 室あたり原価（円・整数）。
 *
 * ── 分母は「清掃実績」で「客室数」ではない ──────────────
 * §7.1 の見本は 8,241,600 円 ÷ 2,847 件 = 2,894 円。**清掃 1 件あたり**を
 * 「1 室あたり」と呼んでいる（1 回の清掃 = 1 室ぶんの作業）。客室数で
 * 割ると桁が 1 つ変わる。
 *
 * 費用が `null`（その月の請求書がまだ無い）なら `null`。
 */
export function costPerTask(cleaningCost: number | null, totalTasks: number): number | null {
  if (cleaningCost === null) return null;
  const value = ratio(cleaningCost, totalTasks);
  if (value === null) return null;
  return Math.floor(value);
}

/** 金額を「¥8,241,600」の形にする。`null` はそのまま返す。 */
export function formatYen(amount: number | null): string | null {
  if (amount === null) return null;
  return `¥${amount.toLocaleString("ja-JP")}`;
}

/** 数字が出せないときの表示。**0 と区別する。** */
export const NO_VALUE = "—";

/** `null` を `—` に落とす。 */
export function orDash(value: string | null): string {
  return value ?? NO_VALUE;
}
