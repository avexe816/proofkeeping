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
 *
 * ── §7.2（清掃会社プラン）の計算もここに置く ────────────
 * P5-15 が足した `formatHours()` / `hourlyRate()` / `isLowHourlyRate()` は
 * 同じ性質のもの（API が返した整数を画面のために割る）。**同じ役目の
 * module を 2 つ置かない。** 画面が違っても、割り算の作法は 1 か所。
 */

import { LOW_HOURLY_RATE_PERCENT } from "@pk/contracts";

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

// ────────────────────────────────────────────────────────────
// 清掃会社プラン（P5-15 / PK-SPEC-P5 §7.2）
// ────────────────────────────────────────────────────────────

/**
 * 実働時間を「631」にする（時間）。**小数を出さない。**
 *
 * §7.2 の見本は `631h` / `478h` / `245h` で、いずれも整数。**切り捨てる。**
 * 実働時間は請求の根拠ではなく、時間単価を読むための桁合わせなので、
 * 分単位の端数を持ち回る意味が無い。
 *
 * **単位を付けない。** 「h」は文言カタログ側（`t()`）に置く
 * （`formatAverageMinutes()` と同じ理由）。
 */
export function formatHours(totalMinutes: number): string {
  return String(Math.floor(totalMinutes / 60));
}

/**
 * 時間単価（円・整数）。**請求額 ÷ 実働時間。**
 *
 * 分母は分なので 60 で割る。**先に時間へ直してから割らない** — 分を
 * 時間へ直す時点で端数が出て、単価が数十円ずれる。`amount * 60 / 分`
 * の順で計算し、最後に切り捨てる（billing.md §4「浮動小数点を使わない」の
 * 趣旨に沿って、割り算を 1 回に閉じる）。
 *
 * 請求額が `null`（その月の請求書がまだ無い）か、実働時間が 0 なら `null`。
 */
export function hourlyRate(billedAmount: number | null, totalMinutes: number): number | null {
  if (billedAmount === null) return null;
  if (totalMinutes <= 0) return null;
  return Math.floor((billedAmount * 60) / totalMinutes);
}

/**
 * 時間単価が組織平均の 85% を下回るか（§7.2 MUST）。
 *
 * ── 施設どうしを比べない ────────────────────────────────
 * 比べる相手は**組織平均**であって、他の施設ではない。§7.2 の見本で
 * ホテルC に印が付くのは「ホテルA より低いから」ではなく「全社の平均より
 * 15% 以上低いから」。上位 2 施設が高いだけの月に、平均並みの施設へ
 * 警告を出さないため。
 *
 * ── 割合を掛けない ──────────────────────────────────────
 * `rate < average * 0.85` と書くと、金額の判定に浮動小数点が入る
 * （billing.md §4）。**両辺を 100 倍した整数の比較**にしてある。
 *
 * 平均が出せない（全社の請求額か実働時間が無い）月は警告を出さない。
 * **比べる相手が無いときに「低い」と言わない。**
 */
export function isLowHourlyRate(
  rate: number | null,
  averageRate: number | null,
  thresholdPercent: number = LOW_HOURLY_RATE_PERCENT,
): boolean {
  if (rate === null || averageRate === null) return false;
  if (averageRate <= 0) return false;
  return rate * 100 < averageRate * thresholdPercent;
}

/** 数字が出せないときの表示。**0 と区別する。** */
export const NO_VALUE = "—";

/** `null` を `—` に落とす。 */
export function orDash(value: string | null): string {
  return value ?? NO_VALUE;
}
