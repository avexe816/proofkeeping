/**
 * 送信 Webhook の配信規則（PK-SPEC-P6 §6.4）。**純粋関数。**
 *
 * task: docs/tasks/P6-13.md
 *
 * ```
 * MUST: 配信は最大 5 回リトライ（1分, 5分, 30分, 2時間, 6時間）。
 *       5 回失敗で無効化し、管理者に通知する。
 * ```
 *
 * ── 受信側（§3.4）と別の表にしてある理由 ────────────────
 * `circuitBreaker.ts` の 5 / 15 / 60 分は**こちらから取りに行く**連携の
 * リトライで、外部 API が復旧するまでの待ちを刻んでいる。こちらは
 * **相手のサーバーへ届けにいく**配信で、仕様の刻みが 1 分から 6 時間まで
 * 大きく開いている。**同じ関数に寄せない。** 片方の値を直したときに
 * もう片方が黙って変わる形にしない。
 *
 * ── 無効化は「止める」であって「消す」ではない ──────────
 * 5 回失敗した宛先は `isActive = false` になるが、行は残る。
 * 相手のサーバーが直ったら人が有効に戻す。**自動では戻さない**
 * （`reactivateIntegration()` と同じ考え方 / DECISIONS #145）。
 */

/** リトライの間隔（分）。**§6.4 の値をそのまま持つ。** */
export const OUTBOUND_RETRY_DELAYS_MINUTES: readonly number[] = [1, 5, 30, 120, 360];

/** 配信の最大試行回数（§6.4 の「最大 5 回リトライ」）。 */
export const OUTBOUND_MAX_ATTEMPTS = OUTBOUND_RETRY_DELAYS_MINUTES.length;

/**
 * 次の再送までの秒数。**打ち止めなら `null`。**
 *
 * @param attempt 何回目の配信が失敗したか。**1 起点**
 *   （Cloudflare Queues の `message.attempts` がそのまま渡せる）。
 *
 * ```
 * attempt=1 → 60      （1 分後）
 * attempt=2 → 300     （5 分後）
 * attempt=3 → 1800    （30 分後）
 * attempt=4 → 7200    （2 時間後）
 * attempt=5 → 21600   （6 時間後）
 * attempt=6 → null    （打ち止め）
 * ```
 */
export function outboundRetryDelaySeconds(attempt: number): number | null {
  const index = Math.max(1, Math.floor(attempt)) - 1;
  const minutes = OUTBOUND_RETRY_DELAYS_MINUTES[index];
  return minutes === undefined ? null : minutes * 60;
}

/** 宛先を無効化する連続失敗回数（§6.4 MUST）。 */
export const OUTBOUND_DISABLE_THRESHOLD = 5;

/**
 * 宛先を無効化するか（§6.4 MUST）。
 *
 * **`>=` で見る。** 5 回目ちょうどで止める。
 */
export function shouldDisableOutbound(failureCount: number): boolean {
  return failureCount >= OUTBOUND_DISABLE_THRESHOLD;
}

/** 配信するイベント（§6.4）。**`packages/db` の写し。** */
export const OUTBOUND_EVENT_VALUES = [
  "room.status_changed",
  "task.completed",
  "inspection.failed",
  "issue.created",
  "finding.created",
  "invoice.issued",
] as const;

export type OutboundEvent = (typeof OUTBOUND_EVENT_VALUES)[number];

/**
 * その宛先へこのイベントを送るか。
 *
 * **前方一致・ワイルドカードを実装しない**（`hasScope()` と同じ理由）。
 * `task.*` のような表記を許すと、イベントを 1 つ足すたびに既存の
 * 宛先へ黙って新しい種類が流れ始める。
 */
export function subscribesTo(events: readonly string[], event: OutboundEvent): boolean {
  return events.includes(event);
}

/**
 * 配信が成功したか（HTTP の応答から）。
 *
 * **2xx だけを成功とする。** 3xx を成功に数えない：リダイレクト先が
 * 別のホストだと、署名を付けたまま知らない相手へ本文を送ることになる。
 * 4xx も失敗として数える。相手の設定が間違っている場合、再送しても
 * 直らないが、**5 回で無効化されるので放置にはならない。**
 */
export function isDeliverySuccess(status: number): boolean {
  return status >= 200 && status < 300;
}
