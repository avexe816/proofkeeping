/**
 * 業務日の算出。**純粋関数。**
 *
 * task:  docs/tasks/P0-21.md
 * ルール: .claude/rules/architecture.md §7
 *
 * ```
 * businessDate = (現地時刻 - 施設の日締め時刻) の日付
 * 既定の日締め時刻 = 05:00 Asia/Tokyo
 * ```
 *
 * 全ての日次集計はこれを基準にする。**カレンダー日を使わない。**
 * 深夜 2 時のチェックアウト清掃は前日の業務として数える。
 *
 * ── タイムゾーンの扱い ──────────────────────────────────
 * `Intl.DateTimeFormat` で施設のタイムゾーンへ落とす。**手計算の
 * オフセットを持たない**（夏時間を持つ地域を将来足したときに壊れる）。
 */

/** 既定の日締め時刻（architecture.md §7）。 */
export const DEFAULT_DAY_CUTOFF_TIME = "05:00";

/** 既定のタイムゾーン。 */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";

/** その瞬間の、指定タイムゾーンでの `YYYY-MM-DD` と時分。 */
function localParts(now: Date, timezone: string): { date: string; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = new Map(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const year = parts.get("year") ?? "1970";
  const month = parts.get("month") ?? "01";
  const day = parts.get("day") ?? "01";
  // hour12: false でも 24 が返る実装がある。0 に寄せる。
  const hour = Number(parts.get("hour") ?? "0") % 24;
  const minute = Number(parts.get("minute") ?? "0");
  return { date: `${year}-${month}-${day}`, minutes: hour * 60 + minute };
}

/** `HH:MM` を分に直す。形が違えば既定（05:00）とみなす。 */
function cutoffMinutes(dayCutoffTime: string): number {
  const matched = /^(\d{2}):(\d{2})$/.exec(dayCutoffTime);
  if (matched === null) return 5 * 60;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return 5 * 60;
  return hour * 60 + minute;
}

/** `YYYY-MM-DD` を 1 日戻す。 */
function previousDate(date: string): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 業務日を求める。
 *
 * 日締め時刻より前なら前日の業務日。
 */
export function businessDateOf(
  now: Date,
  timezone: string = DEFAULT_TIMEZONE,
  dayCutoffTime: string = DEFAULT_DAY_CUTOFF_TIME,
): string {
  const { date, minutes } = localParts(now, timezone);
  return minutes < cutoffMinutes(dayCutoffTime) ? previousDate(date) : date;
}
