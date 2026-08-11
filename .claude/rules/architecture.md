# アーキテクチャルール

DB・API・データモデルを触るときは必ずこれを読む。

## 1. シャーディング

### 構成
- D1 データベースを 16 個使う。`SHARD_00` 〜 `SHARD_15`。
- 全 binding を `wrangler.toml` に静的宣言する。実行時に D1 を作らない。
- ローカル・preview は `SHARD_COUNT=1`。同じコードが動くこと。

### ルーティング
```ts
// packages/db/src/router.ts — ここ以外でシャードを解決しない
export async function resolveShard(env: Env, organizationId: string): Promise<number> {
  const override = await env.SHARD_MAP.get(`shard:${organizationId}`);
  if (override) return Number(override);          // 明示マッピングが優先
  return fnv1a32(organizationId) % Number(env.SHARD_COUNT);
}

export async function getTenantDb(env: Env, ctx: TenantContext) {
  const idx = await resolveShard(env, ctx.organizationId);
  const key = `SHARD_${String(idx).padStart(2, "0")}` as keyof Env;
  const db = env[key] as D1Database | undefined;
  if (!db) throw new Error(`SHARD_BINDING_MISSING:${key}`);
  return drizzle(db, { schema });
}
```

### SHARD_MAP（明示マッピング専用の KV）

`shard:{organizationId}` は **`SHARD_MAP` 専用 namespace に置く。**
`CONFIG` など他の namespace に相乗りさせない。

理由: このキーが失われても `resolveShard()` はエラーにならず、
`fnv1a32` のフォールバックに静かに落ちる。移送済みの組織なら、
以後の読み書きが移送前のシャードへ向かい、**同一テナントのデータが
複数シャードに分裂する。この破損は無警告で進行し、検知が遅れる。**
`CONFIG` は設計上、一括更新・一括削除・TTL 失効の対象になるため同居させない。

**MUST**
- `SHARD_MAP` に書き込むとき `expirationTtl` / `expiration` を指定しない。**TTL を設定してはならない。**
- `SHARD_MAP` に明示マッピング以外のキーを置かない。
- `SHARD_MAP` を一括削除・一括上書きしない。削除は 1 組織の移送完了時のみ。
- 組織を別シャードへ移送したら、移送の完了前に `SHARD_MAP` を書く。

### 禁止
- `env.SHARD_XX` への直接アクセス（ESLint `no-direct-shard-access` で検出）
- リポジトリ層以外での `drizzle(` 呼び出し（ESLint `no-raw-drizzle` で検出）
- シャードをまたぐトランザクション
- シャード番号の外部露出
- `SHARD_MAP` への TTL 付き書き込み

## 2. テナント分離（三重防御）

RLS がない代わりに 3 層で守る。1 つでも欠けたら分離は成立しない。

### 第 1 層 — リポジトリ層の強制注入
すべてのクエリはリポジトリ関数を経由し、`organizationId` を自動付与する。

```ts
export async function findTasks(env: Env, ctx: TenantContext, filter: TaskFilter) {
  const db = await getTenantDb(env, ctx);
  return db.select().from(tasks).where(
    and(
      eq(tasks.organizationId, ctx.organizationId),  // 常に強制
      scopeToProperties(ctx),                         // 施設スコープロール
      ...buildFilter(filter)
    )
  );
}
```

`scopeToProperties()` は `PROPERTY_MANAGER` / `INSPECTOR` / `CLEANER` / `VENDOR_ADMIN` の場合に
`ctx.allowedPropertyIds` で絞る。`OWNER` / `ORG_ADMIN` / `AUDITOR` は組織全体。

### 第 2 層 — ID の自己記述化
```
形式: {orgShortId}__{entityPrefix}_{ulid}
例:   o7k2m9__task_01JBXQ3ZK8N4P2VYR6

orgShortId   組織作成時に採番する 6 桁英数（衝突チェック済）
entityPrefix task/insp/evd/obs/lost/issue/inv/rcp/find/run...
ulid         26 桁。時系列ソート可能
```

URL やリクエストで ID を受け取ったら、DB 問い合わせ前に照合する。

```ts
export function assertIdBelongsToTenant(id: string, ctx: TenantContext) {
  const [orgShortId] = id.split("__");
  if (orgShortId !== ctx.orgShortId) throw new NotFoundError("RESOURCE_NOT_FOUND");
}
```

**403 ではなく 404 を返す。** 403 はリソースの存在を示唆してしまう。

### 第 3 層 — CI での越境テスト
全テーブルについて 4 パターンを用意する。詳細は `testing.md` を参照。

## 3. 集計

テナント横断・施設横断の集計は `dailyPropertyRollup` を使う。
タスクテーブルへの直接集計・JOIN を書かない。

更新は Queue コンシューマが**再計算方式**で行う。インクリメント方式にしない（冪等性のため）。

## 4. Durable Objects

以下 4 用途に限定。汎用データストアとして使わない。

| 名前空間 | 用途 | 粒度 |
|---|---|---|
| `DocumentSequencer` | 請求書・領収書の番号採番 | 組織×文書種別×年度 |
| `InspectionLock` | 検査開始の排他制御 | タスク |
| `PropertyBoard` | 客室ステータスのリアルタイム配信 | 施設 |
| `ReconciliationLock` | 照合バッチの二重起動防止 | 施設×業務日 |

## 5. Queues

CPU 50ms 超の処理は必ず Queue へ。

| キュー | 用途 |
|---|---|
| `pdf-generation` | 日報・請求書・領収書・監査レポート |
| `evidence-export` | 証跡 ZIP |
| `reconciliation` | 稼働照合バッチ |
| `rollup-update` | 集計テーブル更新 |
| `baseline-learning` | 消耗基準値の再計算 |
| `notification` | メール・LINE |
| `archive-restore` | アーカイブ復元 |

すべてのコンシューマは冪等であること。

## 6. マイグレーション

- 後方互換のみ。列の削除・リネーム・型変更を単一リリースで行わない。
- 破壊的変更は 3 段階。①新列追加 → ②両方書き込み・新列から読む → ③旧列削除（次リリース）。
- 16 シャードへ順次実行。1 つ失敗したら以降を中止し、シャード番号を出力。
- 全シャードの `schema_version` 一致を起動時に検証。不一致なら書き込み系 API を 503。

## 7. 業務日

```
businessDate = (現地時刻 - 施設の日締め時刻) の日付
既定の日締め時刻 = 05:00 Asia/Tokyo
```

全ての日次集計は `businessDate` 基準。カレンダー日を使わない。
DB には `YYYY-MM-DD` の text で保存する。
