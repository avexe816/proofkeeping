/**
 * ベースラインの集計ウィンドウ（PK-SPEC-P3 §5.4）。
 *
 * task: docs/tasks/P3-09.md
 *
 * ```
 * 既定: 直近 90 日
 * 最小: 30 日
 * 最大: 180 日（季節性のある施設は 365 日）
 * ```
 *
 * ── 施設ごとの日数を保存する場所が無い ──────────────────
 * §5.4 は「季節性がある施設は 365 日を選択可能」と書くが、§2.6 の
 * `observationConfig` に日数の列が無い。**列を勝手に足さない**
 * （CLAUDE.md §1.4）。当面は全施設 90 日で、施設ごとの選択は
 * docs/OPEN_QUESTIONS.md #062 に上げてある。定数と検査だけ先に置く。
 *
 * ── 分けて読む ──────────────────────────────────────────
 * 90 日ぶんの観察を 1 本のクエリで取ると、大きな施設で D1 の応答上限に
 * 当たる（500 室 × 90 日）。**業務日で区切って読む**ための分割もここに置く。
 */

import { shiftBusinessDate } from "../businessDate.js";

/** 既定の集計ウィンドウ（§5.4）。 */
export const DEFAULT_BASELINE_WINDOW_DAYS = 90;

/** 最小（§5.4）。これより短い指定は既定へ寄せる。 */
export const MIN_BASELINE_WINDOW_DAYS = 30;

/** 最大（§5.4 の季節性のある施設）。 */
export const MAX_BASELINE_WINDOW_DAYS = 365;

/** 1 回のクエリで読む業務日の幅（日）。**D1 の応答上限に対する歯止め。** */
export const BASELINE_CHUNK_DAYS = 15;

/** 集計ウィンドウ（業務日の閉区間）。 */
export interface BaselineWindow {
  from: string;
  to: string;
  days: number;
}

/**
 * ウィンドウ終端の業務日から `from` / `to` を作る。
 *
 * **終端を含む。** 90 日なら `to` の 89 日前が `from`（両端で 90 日）。
 * 範囲外の日数は既定（90 日）へ寄せる。**例外にしない**（バッチが
 * 設定の誤りで止まると、その施設だけベースラインが古いまま残る）。
 */
export function baselineWindowOf(computedTo: string, days: number): BaselineWindow {
  const bounded =
    Number.isInteger(days) && days >= MIN_BASELINE_WINDOW_DAYS && days <= MAX_BASELINE_WINDOW_DAYS
      ? days
      : DEFAULT_BASELINE_WINDOW_DAYS;
  return { from: shiftBusinessDate(computedTo, -(bounded - 1)), to: computedTo, days: bounded };
}

/**
 * ウィンドウを業務日で区切る（冒頭の「分けて読む」）。
 *
 * 返る区間は**すべて閉区間で、隣と重ならない。** 重なると同じ観察を
 * 2 回積むことになり、統計量が壊れる。
 */
export function businessDateChunks(
  window: BaselineWindow,
  chunkDays: number = BASELINE_CHUNK_DAYS,
): { from: string; to: string }[] {
  const size = Number.isInteger(chunkDays) && chunkDays > 0 ? chunkDays : BASELINE_CHUNK_DAYS;
  const chunks: { from: string; to: string }[] = [];
  let cursor = window.from;
  while (cursor <= window.to) {
    const end = shiftBusinessDate(cursor, size - 1);
    const to = end > window.to ? window.to : end;
    chunks.push({ from: cursor, to });
    cursor = shiftBusinessDate(to, 1);
  }
  return chunks;
}
