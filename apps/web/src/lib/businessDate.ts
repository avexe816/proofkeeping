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
 * 業務日を 1 日進める（PK-SPEC-P1 §19.4 の「翌日以降」）。
 *
 * **業務日そのものの計算であって、暦日ではない。** 業務日は
 * `YYYY-MM-DD` の連続した並びなので、日締め時刻を再度考える必要は無い。
 */
export function nextBusinessDate(businessDate: string): string {
  const shifted = new Date(`${businessDate}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return shifted.toISOString().slice(0, 10);
}

/**
 * その瞬間の現地時刻 `HH:MM`（§19.4 の「現在ここ」の判定に使う）。
 *
 * **業務日ではなく時計。** 日締めの前（深夜 3 時）でも `03:00` を返す。
 */
export function localClockOf(now: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const { minutes } = localParts(now, timezone);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
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

/**
 * 業務日を 1 日戻す（P2-14 の日報が「いま終わった業務日」を求めるのに使う）。
 *
 * `nextBusinessDate()` の逆。**日締め時刻を再度考える必要は無い**
 * （業務日は `YYYY-MM-DD` の連続した並び）。
 */
export function previousBusinessDate(businessDate: string): string {
  return previousDate(businessDate);
}

/**
 * その瞬間の現地時刻を「0 時からの分」で返す（P2-14 の日報バッチが使う）。
 *
 * `localClockOf()` と同じ値を文字列ではなく数で返すもの。日締めからの
 * 経過を窓で判定するのに、`"05:10"` を再び分解したくないため。
 */
export function localMinutesOf(now: Date, timezone: string = DEFAULT_TIMEZONE): number {
  return localParts(now, timezone).minutes;
}

/** `HH:MM` を 0 時からの分に直す。形が違えば既定（05:00）とみなす。 */
export function dayCutoffMinutes(dayCutoffTime: string): number {
  return cutoffMinutes(dayCutoffTime);
}
