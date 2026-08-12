/**
 * 送信キューの実体（PK-SPEC-P1 §8.2）。**ブラウザでのみ動く。**
 *
 * task:  docs/tasks/P1-12.md
 * ルール: .claude/rules/ui-writing.md §5
 *
 * ── Background Sync API を使わない（§8.1 MUST）──────────
 * iOS に無い。あるかのように書くと、Android だけで動く実装になり、
 * 現場の端末（iPhone が主）で静かに送信されないまま溜まる。
 * flush は **5 つのトリガー**（§8.2）から明示的に呼ぶ。
 *
 * ── 直列に送る ──────────────────────────────────────────
 * 「開始 → 写真 → チェック → 完了」の順序に意味がある。並列に投げると
 * 完了が開始より先に着き、状態機械が拒否する（`INVALID_TRANSITION`）。
 *
 * ── 判断は `policy.ts` にある ───────────────────────────
 * ここは IndexedDB と `fetch` を触るだけ。再送するかどうかは
 * `verdictOf()` が決める（node でテストできる側に置く）。
 */

import {
  BLOB_STORE,
  QUEUE_STORE,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  isIdbAvailable,
} from "./idb.js";
import {
  MAX_ATTEMPTS,
  backoffDelayMs,
  hasManualRetry,
  hasStaleItems,
  nextToSend,
  resetManualRetry,
  verdictOf,
  verdictOfNetworkFailure,
  type QueuedRequest,
} from "./policy.js";

/** 画面に出す状態。**件数と赤バッジだけ。** */
export interface QueueState {
  /** 未送信の件数（`requiresManualRetry` を含む）。 */
  pending: number;
  /** 5 回失敗したものがある（§8.2 の赤バッジ）。 */
  manualRetry: boolean;
  /** 24 時間以上残っているものがある（§8.1 の赤い警告）。 */
  stale: boolean;
  /** いま送信中か。 */
  flushing: boolean;
  /**
   * 未送信の `QueuedRequest.id`。
   *
   * 画面が**楽観的更新をいつ畳むか**を決めるために要る。積んだ id が
   * キューから消えた ＝ サーバーへ届いた（または諦めた）なので、
   * そこで手元の上書きを捨ててサーバーの値へ戻す（§8.3）。
   */
  ids: readonly string[];
}

type Listener = (state: QueueState) => void;

const listeners = new Set<Listener>();

/**
 * IndexedDB が使えない環境（プライベートブラウズ等）の退避先。
 *
 * **画面を止めない**ことを優先する。タブを閉じたら消えるが、
 * 「保存できないので操作できません」より現場は困らない。
 */
const memoryQueue = new Map<string, QueuedRequest>();
const memoryBlobs = new Map<string, Blob>();

let flushing = false;
let lastState: QueueState = {
  pending: 0,
  manualRetry: false,
  stale: false,
  flushing: false,
  ids: [],
};

async function readQueue(): Promise<QueuedRequest[]> {
  if (!isIdbAvailable()) return [...memoryQueue.values()];
  try {
    return await idbGetAll<QueuedRequest>(QUEUE_STORE);
  } catch {
    return [...memoryQueue.values()];
  }
}

async function writeItem(item: QueuedRequest): Promise<void> {
  memoryQueue.set(item.id, item);
  if (!isIdbAvailable()) return;
  try {
    await idbPut(QUEUE_STORE, item.id, item);
    memoryQueue.delete(item.id);
  } catch {
    // IndexedDB が満杯・失効。メモリ側に残っているので送信は続く。
  }
}

async function dropItem(item: QueuedRequest): Promise<void> {
  memoryQueue.delete(item.id);
  if (item.blobRef !== undefined) memoryBlobs.delete(item.blobRef);
  if (!isIdbAvailable()) return;
  try {
    await idbDelete(QUEUE_STORE, item.id);
    // **本体を消してから実体を消す。** 逆にすると、送信待ちの行が
    // 実体の無い写真を指す（INV-27 に反して端末のデータが先に消える）。
    if (item.blobRef !== undefined) await idbDelete(BLOB_STORE, item.blobRef);
  } catch {
    // 消せなくても次の flush で 409 / 200 になり、そこで消える。
  }
}

async function readBlob(blobRef: string): Promise<Blob | undefined> {
  const inMemory = memoryBlobs.get(blobRef);
  if (inMemory !== undefined) return inMemory;
  if (!isIdbAvailable()) return undefined;
  try {
    return await idbGet<Blob>(BLOB_STORE, blobRef);
  } catch {
    return undefined;
  }
}

/** 状態を配る。**購読者が居なくても呼ぶ**（次の購読で最新が渡る）。 */
async function publish(): Promise<void> {
  const queue = await readQueue();
  lastState = {
    pending: queue.length,
    manualRetry: hasManualRetry(queue),
    stale: hasStaleItems(queue, Date.now()),
    flushing,
    ids: queue.map((item) => item.id),
  };
  for (const listener of listeners) listener(lastState);
}

/** 状態を購読する。登録直後に 1 回呼ばれる。 */
export function subscribeQueue(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastState);
  void publish();
  return () => {
    listeners.delete(listener);
  };
}

function newId(): string {
  // Workers / 近年のブラウザは randomUUID を持つ。無い環境は乱数で代替する
  // （鍵として一意であればよく、暗号強度は要らない）。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `q-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

/** JSON の状態変更を積む（開始・中断・完了・チェックリスト）。 */
export async function enqueueJson(input: {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  body: unknown;
}): Promise<QueuedRequest> {
  const item: QueuedRequest = {
    id: newId(),
    url: input.url,
    method: input.method ?? "POST",
    body: input.body,
    createdAt: Date.now(),
    attempts: 0,
    requiresManualRetry: false,
  };
  await writeItem(item);
  await publish();
  return item;
}

/** 写真を積む。**実体は Blob ストアへ置く**（本体は参照だけ持つ）。 */
export async function enqueuePhoto(input: {
  url: string;
  fields: Record<string, string>;
  blob: Blob;
}): Promise<QueuedRequest> {
  const blobRef = newId();
  memoryBlobs.set(blobRef, input.blob);
  if (isIdbAvailable()) {
    try {
      await idbPut(BLOB_STORE, blobRef, input.blob);
      memoryBlobs.delete(blobRef);
    } catch {
      // メモリ側に残す。
    }
  }

  const item: QueuedRequest = {
    id: newId(),
    url: input.url,
    method: "POST",
    body: null,
    blobRef,
    fields: input.fields,
    createdAt: Date.now(),
    attempts: 0,
    requiresManualRetry: false,
  };
  await writeItem(item);
  await publish();
  return item;
}

/** 1 件送る。**応答の扱いは `policy.ts` が決める。** */
async function sendOne(item: QueuedRequest): Promise<void> {
  const attempts = item.attempts + 1;

  let response: Response;
  try {
    if (item.blobRef === undefined) {
      response = await fetch(item.url, {
        method: item.method,
        headers: { "Content-Type": "application/json", "Idempotency-Key": item.id },
        body: JSON.stringify(item.body),
      });
    } else {
      const blob = await readBlob(item.blobRef);
      if (blob === undefined) {
        // 実体が消えている。送りようが無いので捨てる（再撮影を促す）。
        await dropItem(item);
        return;
      }
      const form = new FormData();
      for (const [key, value] of Object.entries(item.fields ?? {})) form.append(key, value);
      form.append("file", blob, "photo.jpg");
      response = await fetch(item.url, {
        method: item.method,
        headers: { "Idempotency-Key": item.id },
        body: form,
      });
    }
  } catch (error) {
    const verdict = verdictOfNetworkFailure(attempts);
    await writeItem({
      ...item,
      attempts,
      lastError: error instanceof Error ? error.name : "NETWORK",
      requiresManualRetry: verdict.kind === "GIVE_UP",
    });
    return;
  }

  const verdict = verdictOf(response.status, attempts);
  if (verdict.kind === "DONE") {
    await dropItem(item);
    return;
  }
  await writeItem({
    ...item,
    attempts,
    lastError: `HTTP_${String(response.status)}`,
    requiresManualRetry: verdict.kind === "GIVE_UP",
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * キューを空になるまで送る（§8.2）。
 *
 * **多重に走らせない。** 二重に走ると同じ item を 2 回送り、
 * `Idempotency-Key` で救われるとはいえ写真の往復が倍になる。
 *
 * オフラインなら何もしない。`navigator.onLine` は「繋がっている」ことを
 * 保証しないが、「繋がっていない」ことはよく当たる。
 */
export async function flushQueue(): Promise<void> {
  if (flushing) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;

  flushing = true;
  await publish();
  try {
    for (;;) {
      const queue = await readQueue();
      const item = nextToSend(queue);
      if (item === undefined) break;

      const wait = backoffDelayMs(item.attempts);
      if (wait > 0) await sleep(wait);

      const before = item.attempts;
      await sendOne(item);
      await publish();

      // 失敗して回数だけが増えた場合、次の周回で同じ item を選ぶ。
      // **5 回に達したら `requiresManualRetry` が立ち、`nextToSend()` が
      // 返さなくなる**ので、この for は必ず終わる。
      if (before + 1 >= MAX_ATTEMPTS) {
        const after = (await readQueue()).find((row) => row.id === item.id);
        if (after !== undefined && after.requiresManualRetry) continue;
      }
    }
  } finally {
    flushing = false;
    await publish();
  }
}

/** 赤バッジのものを積み直して送る（未送信バーのタップ）。 */
export async function retryFailed(): Promise<void> {
  const queue = await readQueue();
  for (const item of queue) {
    if (item.requiresManualRetry) await writeItem(resetManualRetry(item));
  }
  await publish();
  await flushQueue();
}

/**
 * flush の 5 つのトリガーを繋ぐ（§8.2）。**戻り値は解除関数。**
 *
 * ```
 * 1. window の "online"
 * 2. document の visibilitychange → visible
 * 3. 未送信バーのタップ            … 画面が retryFailed() / flushQueue() を呼ぶ
 * 4. 30 秒ごとのポーリング
 * 5. タスク完了操作の直後          … 画面が flushQueue() を呼ぶ
 * ```
 *
 * ── 何度呼んでも 1 組しか動かない ───────────────────────
 * 画面ごとに hook が呼ぶ（`useOfflineQueue()`）ので、参照を数えて
 * **最初の 1 回だけ**購読とタイマーを張る。二重に張ると 30 秒ごとの
 * flush が画面の数だけ走り、写真の往復がその倍になる。
 */
let autoFlushHolders = 0;
let stopAutoFlush: (() => void) | null = null;

export function startAutoFlush(intervalMs: number): () => void {
  autoFlushHolders += 1;
  if (autoFlushHolders === 1) {
    const onOnline = (): void => {
      void flushQueue();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void flushQueue();
    };
    const timer = setInterval(() => {
      void flushQueue();
    }, intervalMs);

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    void flushQueue();

    stopAutoFlush = () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    autoFlushHolders -= 1;
    if (autoFlushHolders === 0 && stopAutoFlush !== null) {
      stopAutoFlush();
      stopAutoFlush = null;
    }
  };
}
