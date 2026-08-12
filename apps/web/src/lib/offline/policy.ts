/**
 * 送信キューの規則（PK-SPEC-P1 §8.2 / ui-writing.md §5）。**純粋関数。**
 *
 * task: docs/tasks/P1-12.md
 *
 * ── IndexedDB から切り離してある理由 ────────────────────
 * テストは node で走る（testing.md / vitest.config.ts の `environment: "node"`）。
 * `indexedDB` も `fetch` も無い環境で、**再送の規則そのものを直接
 * 押さえられるようにする。** キューの実体（`queue.ts`）はこの規則を
 * 呼ぶだけにして、判断をブラウザの中へ持ち込まない。
 */

/** キューに積む 1 件（§8.2 の `QueuedRequest`）。 */
export interface QueuedRequest {
  /** uuid。**そのまま `Idempotency-Key` になる。** */
  id: string;
  url: string;
  method: "POST" | "PUT" | "PATCH";
  /** JSON の本体。写真は `blobRef` 側に持つ。 */
  body: unknown;
  /** 写真の場合、IndexedDB 内の Blob のキー。 */
  blobRef?: string | undefined;
  /** multipart で送るときのテキスト部（写真のメタデータ）。 */
  fields?: Record<string, string> | undefined;
  createdAt: number;
  attempts: number;
  lastError?: string | undefined;
  requiresManualRetry: boolean;
}

/** これ以上は自動で再送しない回数（§8.2）。 */
export const MAX_ATTEMPTS = 5;

/** 未送信が残りすぎていると警告する境（§8.1）。 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** オンライン時のポーリング間隔（§8.2 の flush トリガー 4）。 */
export const FLUSH_POLL_INTERVAL_MS = 30_000;

/**
 * 指数バックオフ（§8.2）。`1s, 2s, 4s, 8s, 16s`。
 *
 * `attempts` は**その時点で失敗した回数**。0 回失敗（初回）は待たない。
 */
export function backoffDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const capped = Math.min(attempts, MAX_ATTEMPTS);
  return 1000 * 2 ** (capped - 1);
}

/** 送信の結果に対する扱い。 */
export type SendVerdict =
  /** キューから消す。 */
  | { kind: "DONE" }
  /** 後でもう一度送る。 */
  | { kind: "RETRY" }
  /** 自動再送を止め、赤バッジで人に委ねる（§8.2）。 */
  | { kind: "GIVE_UP" };

/**
 * HTTP の応答から次の扱いを決める。
 *
 * ── 409 は成功として扱う（§8.2 MUST）────────────────────
 * 「既に処理済」なのでキューから消す。**サーバーは 409 を作らない実装
 * （`Idempotency-Key` で 200 を返す / routes/api/v1/tasks.ts）だが、
 * 状態機械の拒否（`INVALID_TRANSITION`）も 409 で返る。** どちらも
 * 「もう一度送っても同じ」なので、再送を続ける意味が無い。
 *
 * ── 4xx は捨てる、5xx は粘る ────────────────────────────
 * 400 / 404 は端末側の状態が古いだけで、何度送っても通らない。
 * 401 だけは別扱いにしていない（セッション切れは再ログインで直るが、
 * その判断は画面がする。キューは持ち続け、次の flush で通る）。
 */
export function verdictOf(status: number, attempts: number): SendVerdict {
  if (status >= 200 && status < 300) return { kind: "DONE" };
  if (status === 409) return { kind: "DONE" };
  if (status === 401) return attempts >= MAX_ATTEMPTS ? { kind: "GIVE_UP" } : { kind: "RETRY" };
  if (status >= 400 && status < 500) return { kind: "GIVE_UP" };
  return attempts >= MAX_ATTEMPTS ? { kind: "GIVE_UP" } : { kind: "RETRY" };
}

/** 通信そのものが失敗した場合（オフライン・切断）。**回数だけで決める。** */
export function verdictOfNetworkFailure(attempts: number): SendVerdict {
  return attempts >= MAX_ATTEMPTS ? { kind: "GIVE_UP" } : { kind: "RETRY" };
}

/** 赤バッジを出すか（§8.2 の「5 回失敗で `requiresManualRetry`」）。 */
export function hasManualRetry(queue: readonly QueuedRequest[]): boolean {
  return queue.some((item) => item.requiresManualRetry);
}

/** 24 時間以上残っている未送信があるか（§8.1 の赤い警告）。 */
export function hasStaleItems(queue: readonly QueuedRequest[], now: number): boolean {
  return queue.some((item) => now - item.createdAt >= STALE_AFTER_MS);
}

/**
 * 次に送る 1 件を選ぶ。**直列送信**（§8.2「並列にしない」）。
 *
 * 積んだ順（`createdAt` 昇順）。同時刻なら `id` で決める。
 * `requiresManualRetry` は自動では選ばない — 人が押したときだけ
 * `resetManualRetry()` を通してから積み直す。
 */
export function nextToSend(queue: readonly QueuedRequest[]): QueuedRequest | undefined {
  return [...queue]
    .filter((item) => !item.requiresManualRetry)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
}

/** 手動の再試行。**回数を 0 に戻す**（また 5 回粘れるようにする）。 */
export function resetManualRetry(item: QueuedRequest): QueuedRequest {
  return { ...item, attempts: 0, requiresManualRetry: false, lastError: undefined };
}
