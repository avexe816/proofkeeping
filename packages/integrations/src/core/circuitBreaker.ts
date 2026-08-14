/**
 * リトライとサーキットブレーカー（PK-SPEC-P6 §3.4）。**純粋関数。**
 *
 * task: docs/tasks/P6-07.md
 * 仕様: docs/PK-SPEC-P6.md §3.4 / §1.2
 *
 * ```
 * 失敗時のリトライ: 5分後、15分後、60分後（最大 3 回）
 * consecutiveFailures >= 5 → status = ERROR、自動同期を停止
 *                         → 管理画面に警告、メール通知
 * 手動で再接続テストに成功したら status = ACTIVE に戻る
 * ```
 *
 * ── なぜ P6-06（実 PMS）を待たずに置くか ─────────────────
 * P6-07 の依存は P6-06（PMS アダプタ 1 社）だが、**実接続する PMS は
 * 未確定で、その task は人間待ちに置いてある**（§11 の未決事項 1）。
 * 一方この 2 つの判断は連携先を 1 つも知らない。見ているのは
 * `consecutiveFailures`（P6-01 が置いた列）と失敗の回数だけで、
 * `if (vendor === "xxx")` が入る余地が無い。**アダプタが来たときに
 * そのまま効く形で先に置く**（docs/DECISIONS.md #141）。
 *
 * ── 落ちても全体を止めない（§1.2 MUST）─────────────────
 * ここが返すのは「いつ再試行するか」と「自動同期を止めるか」だけで、
 * **照合バッチの可否を決めない。** `status = ERROR` は「その日の稼働記録が
 * 未取得」という状態であって、システムの異常ではない。照合は A 系統が
 * 欠けても B 系統だけで完走する（`consumers/reconciliation.ts` は
 * `integration` を 1 度も読まない）。手動 CSV 取込も同じ理由で無効化しない。
 */

/**
 * 失敗してから次に試すまでの分数（§3.4）。**最大 3 回。**
 *
 * 5 → 15 → 60。指数バックオフではなく仕様の値をそのまま持つ。
 * 外部 API の復旧は「数分で戻る」か「1 時間以上かかる」に割れることが多く、
 * 2 倍ずつ刻んでも当たりが増えない。
 */
export const RETRY_DELAYS_MINUTES: readonly number[] = [5, 15, 60];

/** リトライの上限回数（§3.4）。 */
export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MINUTES.length;

/**
 * 次のリトライまでの秒数。**打ち止めなら `null`。**
 *
 * @param attempt 何回目の試行が失敗したか。**1 起点**（Cloudflare Queues の
 *   `message.attempts` がそのまま渡せる）。0 以下は 1 回目として扱う。
 *
 * ```
 * attempt=1 → 300（5 分後）
 * attempt=2 → 900（15 分後）
 * attempt=3 → 3600（60 分後）
 * attempt=4 → null（打ち止め）
 * ```
 */
export function retryDelaySeconds(attempt: number): number | null {
  const index = Math.max(1, Math.floor(attempt)) - 1;
  const minutes = RETRY_DELAYS_MINUTES[index];
  return minutes === undefined ? null : minutes * 60;
}

/** これ以上リトライするか（§3.4 の「最大 3 回」）。 */
export function shouldRetry(attempt: number): boolean {
  return retryDelaySeconds(attempt) !== null;
}

/** 自動同期を止める連続失敗回数（§3.4）。 */
export const CIRCUIT_OPEN_THRESHOLD = 5;

/**
 * サーキットブレーカーを開くか（§3.4）。
 *
 * **`>=` で見る。** 5 回目ちょうどで開く。`consecutiveFailures` は
 * `markIntegrationSynced()` が積む値で、飛ぶことはないが、
 * 6 以上で開かない実装にすると復旧の取りこぼしが起きる。
 */
export function shouldOpenCircuit(consecutiveFailures: number): boolean {
  return consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD;
}

/** サーキットブレーカーが開いているとみなす状態。 */
export type CircuitState = "CLOSED" | "OPEN";

/**
 * いまの状態を返す。
 *
 * `status = "ERROR"` は**開いている**。`consecutiveFailures` が閾値に
 * 達していても `status` がまだ `ERROR` でなければ、開く操作がこれから
 * 行われる（`shouldOpenCircuit()` が真）。**2 つを 1 つの真偽値に
 * 潰さない**：片方は保存された事実、もう片方はこれからの判断。
 */
export function circuitStateOf(status: string): CircuitState {
  return status === "ERROR" ? "OPEN" : "CLOSED";
}

/**
 * 自動同期（PULL）を走らせてよいか（§3.4 の「自動同期を停止」）。
 *
 * **`PUSH` の受信はこれで止めない。** 外部から届いたイベントを捨てると、
 * その時刻の記録が二度と手に入らない。止めるのは**こちらから取りに行く
 * 側**だけで、届いたものは受ける（`SUSPENDED` は別。あれは利用者が
 * 明示的に止めた状態）。
 */
export function canRunScheduledSync(status: string): boolean {
  return status === "ACTIVE";
}
