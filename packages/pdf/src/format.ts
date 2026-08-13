/**
 * 日報の表示整形。**純粋関数。**
 *
 * task: docs/tasks/P2-14.md
 * 仕様: docs/PK-SPEC-P2.md §9.2
 *
 * ── payload は UTC、紙は現地時刻 ────────────────────────
 * payload の時刻は ISO 8601 UTC（`@pk/engine` の `isoUtc()`）。
 * 日報を読むのは施設の人なので、**紙の上は施設のタイムゾーンの時刻**にする。
 * 変換は `Intl.DateTimeFormat` に任せる（手計算のオフセットを持たない /
 * `apps/web/src/lib/businessDate.ts` と同じ方針）。
 *
 * ── 空欄を "-" にしない ─────────────────────────────────
 * 未計測（`null`）は空欄のままにする。`-` を置くと「0 分」と読めてしまう。
 */

/** `2026-09-10T04:30:00.000Z` → `13:30`（Asia/Tokyo）。 */
export function formatClock(iso: string | null, timezone: string): string {
  if (iso === null) return "";
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return formatter.format(new Date(iso));
}

/** `2026-09-11T05:10:00.000Z` → `2026年9月11日 14:10`（Asia/Tokyo）。 */
export function formatDateTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  const parts = new Map(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year") ?? "";
  // **`month: "numeric"` でも 2 桁で返す実装がある**（`en-CA` は `09`）。
  // 業務日の表記（`formatBusinessDate()`）と揃えるため数に通してから戻す。
  const month = String(Number(parts.get("month") ?? "0"));
  const day = String(Number(parts.get("day") ?? "0"));
  const hour = parts.get("hour") ?? "";
  const minute = parts.get("minute") ?? "";
  return `${year}年${month}月${day}日 ${hour}:${minute}`;
}

/** `2026-09-10` → `2026年9月10日`。**業務日は文字列のまま扱う**（時刻を持たない）。 */
export function formatBusinessDate(businessDate: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (matched === null) return businessDate;
  return `${matched[1] ?? ""}年${String(Number(matched[2]))}月${String(Number(matched[3]))}日`;
}

/** 件数。**単位を付ける**（§9.2 の「52件」）。 */
export function formatCount(count: number): string {
  return `${String(count)}件`;
}

/** 分。未計測（`null`）は空欄（冒頭の注記）。 */
export function formatMinutes(minutes: number | null): string {
  return minutes === null ? "" : String(minutes);
}

/** 再清掃の回数。**0 回は空欄**（表を数字で埋めない）。 */
export function formatReworkCount(count: number): string {
  return count === 0 ? "" : String(count);
}
