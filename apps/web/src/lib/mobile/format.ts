/**
 * 現場画面の数値・時刻の書式（PK-SPEC-P1 §9.2・§9.3）。**純粋関数。**
 *
 * task: docs/tasks/P1-08.md / docs/tasks/P1-09.md
 *
 * ── `t()` に補間が無いための置き場 ──────────────────────
 * `lib/i18n.ts` は `t("key")` だけで、`{n}` の差し込みを持たない
 * （語順が言語で変わるため）。**数値と単位は別の要素として組む**という
 * 方針なので、数値そのものを作る関数をここに置く。**ここで日本語を
 * 返さないこと。** 単位のラベルは画面が `t()` で付ける。
 */

/** 経過時間 `MM:SS`（1 時間を超えたら `H:MM:SS`）。**負の値は 0 に倒す。** */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours === 0 ? `${mm}:${ss}` : `${String(hours)}:${mm}:${ss}`;
}

/** 分に丸めた経過（切り捨て）。集計と同じ向きに倒す（`actualMinutesOf()`）。 */
export function elapsedMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / 60_000));
}

/**
 * 施設の時刻帯での `HH:MM`。
 *
 * **端末のタイムゾーンを使わない。** 共用端末の設定は現場を表さない
 * （ui-writing.md §1 がブラウザの言語設定を読まないのと同じ理由）。
 * 施設のタイムゾーンを渡すこと。既定は日本（`Asia/Tokyo`）。
 */
export function formatClock(epochMs: number, timeZone = "Asia/Tokyo"): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(epochMs));
}

/**
 * `YYYY-MM-DD` を `M/D` に縮める（M-02 の見出し）。
 *
 * 曜日は付けない。曜日名は言語ごとに要る文言で、`t()` に補間が無い以上
 * 7 キー × 言語を並べることになる。**日付は数字だけで読める。**
 */
export function formatShortDate(businessDate: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (matched === null) return businessDate;
  return `${String(Number(matched[2]))}/${String(Number(matched[3]))}`;
}
