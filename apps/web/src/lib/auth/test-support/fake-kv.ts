/**
 * Workers KV の代役。**テスト専用。**
 *
 * task: docs/tasks/P0-08.md
 *
 * ── なぜ代役なのか ──────────────────────────────────────
 * P0-02 が未完で、実在する KV namespace が 1 つも無い（`wrangler.toml` の id は
 * すべて `TODO-P0-02-未作成-*`）。`packages/db/src/test-support/fake-d1.ts` が
 * 採った「注入した代役で全分岐を決定的に検証する」方式に揃える。
 *
 * ── 何を再現するか ──────────────────────────────────────
 * `get` / `put` / `delete` と `expirationTtl` の記録のみ。**TTL による
 * 自動失効は再現しない。** 期限切れの経路はレコード内の `expiresAt` で
 * 検証する（KV の失効は結果整合で遅れうるため、実装もそちらを正としている）。
 */

interface StoredValue {
  value: string;
  expirationTtl: number | undefined;
}

export interface FakeKv {
  /** `Env` に差し込む namespace。 */
  readonly namespace: KVNamespace;
  /** 現在の中身。キーは実装が組み立てたそのままの文字列。 */
  readonly store: Map<string, StoredValue>;
  /** 削除されたキー（順序つき）。 */
  readonly deleted: string[];
  /** テストから直接書く。 */
  seed(key: string, value: string): void;
}

export function createFakeKv(): FakeKv {
  const store = new Map<string, StoredValue>();
  const deleted: string[] = [];

  const namespace = {
    get: (key: string): Promise<string | null> => Promise.resolve(store.get(key)?.value ?? null),
    put: (key: string, value: string, options?: { expirationTtl?: number }): Promise<void> => {
      store.set(key, { value, expirationTtl: options?.expirationTtl });
      return Promise.resolve();
    },
    delete: (key: string): Promise<void> => {
      store.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
  };

  return {
    namespace: namespace as unknown as KVNamespace,
    store,
    deleted,
    seed(key, value) {
      store.set(key, { value, expirationTtl: undefined });
    },
  };
}
