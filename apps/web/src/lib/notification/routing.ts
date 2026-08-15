/**
 * 通知の宛先とチャネルの解決（PK-SPEC-P6 §5.1〜§5.3）。**純粋。**
 *
 * task:  docs/tasks/P6-09.md
 * ルール: .claude/rules/ui-writing.md §6
 *
 * ── ここに DB も fetch も現在時刻も持ち込まない ──────────
 * `packages/engine` と同じ作法（CLAUDE.md §5）。判定に要る値は
 * すべて引数で受け取る。**`Date.now()` を書かない。** 静音時間は
 * 施設の地域時刻で決まるので、`"HH:MM"` に直したものを受け取る。
 *
 * ── 落とす方向へ倒す ────────────────────────────────────
 * 判断に迷う場面（設定が壊れている・イベントを知らない・端末の条件が
 * 分からない）では、**送らない側へ倒す。** 通知は補助機能で
 * （§1.3 MUST）、送り損ねても業務は止まらない。逆に、届くべきでない
 * 相手へ 1 通届くと security.md §1 の境界が崩れる。
 */

import type { NotificationChannel } from "@pk/db";

import { canReceive, findNotificationEvent, type NotificationAudience } from "./events.js";

/** 既定の静音時間（§5.3）。 */
export const DEFAULT_QUIET_HOURS_FROM = "22:00";
export const DEFAULT_QUIET_HOURS_TO = "07:00";

/** 静音時間に止めるチャネル（§5.3 の「PUSH / LINE を送らない」）。 */
const QUIET_HOURS_CHANNELS: ReadonlySet<NotificationChannel> = new Set(["PUSH", "LINE"]);

/** `"HH:MM"` を 0〜1439 の分に直す。**形が違えば `null`。** */
export function parseClock(value: string): number | null {
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (matched === null) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}

/**
 * いま静音時間か（§5.3）。
 *
 * **日をまたぐ**（22:00-07:00）。`from > to` のときは
 * 「`from` 以降**または** `to` 未満」で見る。またがない設定
 * （09:00-17:00）も同じ関数で扱える。
 *
 * 境界は `from` を含み `to` を含まない。22:00 ちょうどは静音、
 * 07:00 ちょうどは静音ではない。**送らない側の窓を広げすぎない。**
 *
 * 設定の形が壊れていたら**既定（22:00-07:00）で見る。** `false` に
 * 倒すと、壊れた設定が「一日中いつでも送ってよい」になる。
 */
export function isQuietHours(
  localTime: string,
  from: string = DEFAULT_QUIET_HOURS_FROM,
  to: string = DEFAULT_QUIET_HOURS_TO,
): boolean {
  const now = parseClock(localTime);
  if (now === null) return true; // 時刻が読めない。**送らない側へ。**
  const start = parseClock(from) ?? parseClock(DEFAULT_QUIET_HOURS_FROM) ?? 0;
  const end = parseClock(to) ?? parseClock(DEFAULT_QUIET_HOURS_TO) ?? 0;
  if (start === end) return false; // 幅ゼロ。静音時間なし。
  return start > end ? now >= start || now < end : now >= start && now < end;
}

/** `resolveChannels()` の入力。 */
export interface ChannelResolution {
  /** §5.1 の `eventCode`。**知らないコードは何も返さない。** */
  eventCode: string;
  /** 受け取る相手。7 ロールか `COUNTERPARTY`。 */
  audience: NotificationAudience;
  /**
   * `notification_preference` の行。**無ければ `null`**（既定のまま）。
   * 行が無いことが「既定」を表す（`schema/integration.ts` の注記）。
   */
  preference: {
    channels: readonly NotificationChannel[];
    quietHoursFrom: string | null;
    quietHoursTo: string | null;
  } | null;
  /** 施設の地域時刻での `"HH:MM"`。 */
  localTime: string;
  /**
   * その相手に届く `PUSH` の購読があるか（§5.2）。
   *
   * **`isStandalone` が真の購読だけを数えること。** iOS はホーム画面に
   * 追加された PWA でしか受信できない。判定は呼び出し側（P6-10）。
   */
  pushAvailable: boolean;
}

/**
 * 実際に送るチャネルを決める（§5.1〜§5.3）。
 *
 * ```
 * ① 受け取ってよい相手か（§5.1 MUST / `canReceive()`）
 * ② 既定チャネル、または利用者の設定
 * ③ PUSH の条件を満たさなければ IN_APP へ落とす（§5.2）
 * ④ 静音時間なら PUSH / LINE を落とす（§5.3。`issue.critical` は例外）
 * ```
 *
 * @returns 送るチャネル。**空配列は「何も送らない」。**
 *   `IN_APP` を含むのは「外へは送らず、画面が出す」の意味
 *   （`events.ts` の注記）。並びは §5.1 の既定チャネルの順。
 */
export function resolveChannels(input: ChannelResolution): NotificationChannel[] {
  const event = findNotificationEvent(input.eventCode);
  if (event === undefined) return [];
  // ① **ここが security.md §1 の境界。** 表と `CLEANER` の定数の両方を見る。
  if (!canReceive(input.audience, input.eventCode)) return [];

  // ② 設定が無ければ既定。**空配列の設定は「全部止める」**（`null` と区別する）。
  const requested = input.preference?.channels ?? event.defaultChannels;

  const resolved: NotificationChannel[] = [];
  for (const channel of requested) {
    // ③ §5.2: 条件を満たさない PUSH は `IN_APP` へフォールバックする。
    if (channel === "PUSH" && !input.pushAvailable) {
      if (!resolved.includes("IN_APP")) resolved.push("IN_APP");
      continue;
    }
    // ④ §5.3: 静音時間は PUSH / LINE を送らない。**例外は `issue.critical`。**
    if (
      QUIET_HOURS_CHANNELS.has(channel) &&
      !event.ignoresQuietHours &&
      isQuietHours(
        input.localTime,
        input.preference?.quietHoursFrom ?? DEFAULT_QUIET_HOURS_FROM,
        input.preference?.quietHoursTo ?? DEFAULT_QUIET_HOURS_TO,
      )
    ) {
      // **落としたぶんを `IN_APP` へ振り替える。** 静音時間は「起こさない」
      // であって「知らせない」ではない。画面を開けば分かる状態は保つ。
      if (!resolved.includes("IN_APP")) resolved.push("IN_APP");
      continue;
    }
    if (!resolved.includes(channel)) resolved.push(channel);
  }
  return resolved;
}

/** 外部へ実際に送るチャネル（`IN_APP` は画面が出す / `events.ts` の注記）。 */
export function outboundChannelsOf(channels: readonly NotificationChannel[]): NotificationChannel[] {
  return channels.filter((channel) => channel !== "IN_APP");
}
