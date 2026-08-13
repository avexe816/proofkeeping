/**
 * 日報の自動生成のタイミング（PK-SPEC-P2 §9.3）。**純粋関数。**
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/architecture.md §7（業務日）
 *
 * ```
 * 毎日、施設の businessDayCutoff の 10 分後に自動生成（§9.3）
 * ```
 *
 * ── 日締め時刻は施設ごとに違う ──────────────────────────
 * 既定は 05:00 Asia/Tokyo だが、施設が設定できる（`property.dayCutoffTime`）。
 * **「05:10 に走る cron」を書くと、日締めを変えた施設で日報が出ない。**
 * そこで cron は 10 分ごとに回り、**その回が自分の日締め + 10 分の窓に
 * 入る施設だけ**を拾う。判定がこの関数。
 *
 * ── 窓で判定する理由 ────────────────────────────────────
 * 日締めは分単位で設定できる（`05:07` もありうる）。「ちょうど 10 分後」で
 * 一致を見ると、10 分ごとの cron とは永久にすれ違う。
 * **`[日締め + 10 分, 日締め + 10 分 + 刻み)` に入っていれば生成する。**
 * 刻みが 10 分なら、1 日にちょうど 1 回だけこの窓に入る。
 * 実際の生成は「日締めの 10〜20 分後」になる（`05:07` の施設は `05:20`）。
 *
 * ── 生成する業務日 ──────────────────────────────────────
 * 日締めの直後に立っているので、**いま終わったのは 1 つ前の業務日。**
 * `businessDateOf(now)` は既に新しい業務日を指しているため、1 日戻す。
 * これは日締めが 23:55 のような値でも成り立つ（`businessDateOf()` が
 * 日付の繰り上げ・繰り下げを持っているため）。
 */

import {
  businessDateOf,
  dayCutoffMinutes,
  localMinutesOf,
  previousBusinessDate,
} from "../businessDate.js";

/** cron の刻み（分）。**wrangler.toml の `*&#47;10 * * * *` と揃える。** */
export const DAILY_REPORT_TICK_MINUTES = 10;

/** 日締めから生成までの待ち（分）。§9.3 の「10 分後」。 */
export const DAILY_REPORT_DELAY_MINUTES = 10;

const MINUTES_PER_DAY = 24 * 60;

/** 判定に要る施設の設定だけ。**行そのものを渡さない**（テストが重くなる）。 */
export interface DailyReportScheduleInput {
  timezone: string;
  dayCutoffTime: string;
}

/**
 * この cron の回で日報を作るべきか。作るなら**対象の業務日**を返す。
 *
 * @param now cron の発火時刻。**この関数の中で `Date.now()` を呼ばない。**
 * @returns 生成する業務日（`YYYY-MM-DD`）。対象外なら `null`。
 */
export function dueBusinessDate(
  now: Date,
  property: DailyReportScheduleInput,
  tickMinutes: number = DAILY_REPORT_TICK_MINUTES,
): string | null {
  const cutoff = dayCutoffMinutes(property.dayCutoffTime);
  const target = (cutoff + DAILY_REPORT_DELAY_MINUTES) % MINUTES_PER_DAY;
  const nowMinutes = localMinutesOf(now, property.timezone);

  // 窓が日付をまたぐ場合があるので、目標からの差を 1 日で巻いて見る。
  const sinceTarget = (nowMinutes - target + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (sinceTarget >= tickMinutes) return null;

  return previousBusinessDate(businessDateOf(now, property.timezone, property.dayCutoffTime));
}
