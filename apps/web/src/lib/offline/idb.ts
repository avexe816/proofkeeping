/**
 * IndexedDB の薄い包み（PK-SPEC-P1 §8.1）。**ブラウザでのみ動く。**
 *
 * task:  docs/tasks/P1-12.md
 * ルール: .claude/rules/ui-writing.md §5
 *
 * ── 永続ストアとして扱わない ────────────────────────────
 * iOS Safari のタブは 7 日で storage を落とす（§8.1）。ここに置くのは
 * **消えても業務が壊れないものだけ。** 設定・マスタ・認証情報を置かない。
 *
 * P1-12 の時点では「1 勤務のあいだの送信バッファだけ」と書いていたが、
 * §19.7 MUST が `my-day` の応答のキャッシュを要求するため P1-21 が
 * `CACHE_STORE` を足した。**読み取りキャッシュは消えても復帰できる**
 * （オンラインになれば取り直す）ので、この方針とは矛盾しない。
 *
 * ── ライブラリを入れていない ────────────────────────────
 * `idb` の類を足すと Worker のバンドルにも載る。使う API は
 * `put` / `getAll` / `delete` の 3 つで、素の IndexedDB で足りる。
 */

const DB_NAME = "pk-offline";

/**
 * スキーマ版。**`CACHE_STORE` を足したので 1 → 2。**
 *
 * `onupgradeneeded` は「無い store だけ作る」形なので、既存の
 * `queue` / `blob` の中身は保たれる。**送信待ちを消さないこと。**
 */
const DB_VERSION = 2;

/** 送信待ちのリクエスト。キーは `QueuedRequest.id`。 */
export const QUEUE_STORE = "queue";

/** 写真の実体。キーは `blobRef`。**送信できるまで消さない**（INV-27）。 */
export const BLOB_STORE = "blob";

/**
 * 読み取りキャッシュ（§19.7）。キーは用途ごとの固定文字列。
 *
 * **1 日単位で 1 件。** 施設ごとに分けない（§19.7 MUST）。分けると
 * 「施設 A は取れているが B は古い」という、現場に説明できない状態ができる。
 */
export const CACHE_STORE = "cache";

/** IndexedDB が使えるか。SSR とプライベートブラウズの両方で false になりうる。 */
export function isIdbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IDB_OPEN_FAILED"));
    };
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IDB_REQUEST_FAILED"));
    };
  });
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await promisify(run(db.transaction(store, mode).objectStore(store)));
  } finally {
    db.close();
  }
}

/** 1 件書く（上書き）。 */
export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  await withStore(store, "readwrite", (s) => s.put(value, key));
}

/** 1 件読む。無ければ `undefined`。 */
export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return withStore<T | undefined>(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

/** 全件読む。 */
export async function idbGetAll<T>(store: string): Promise<T[]> {
  return withStore<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

/** 1 件消す。**送信が終わったものだけ**（INV-27）。 */
export async function idbDelete(store: string, key: string): Promise<void> {
  await withStore(store, "readwrite", (s) => s.delete(key));
}
