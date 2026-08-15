# アーキテクチャ図

**版**: v1.0（2026-08-15）
**対象**: 社内（運用者・開発者）
**仕様**: docs/PK-SPEC-P7.md §7.2

実装の規則は `.claude/rules/architecture.md`。
**ここは「今どう組まれているか」を 1 枚で見るための図。**

---

## 1. 全体

```
                       ┌──────────────────────────────┐
   ブラウザ            │  Cloudflare Workers          │
   /m/*  現場      ───▶│  apps/web (Hono)             │
   /app/* 管理         │                              │
   /api/v1/* API       │  middleware                  │
                       │    session → tenant          │
                       │    → resourceGuard           │
                       └───┬───────┬────────┬─────────┘
                           │       │        │
              ┌────────────┘       │        └──────────────┐
              ▼                    ▼                       ▼
   ┌────────────────────┐  ┌───────────────┐   ┌────────────────────┐
   │ D1 × 16            │  │ Workers KV    │   │ R2                 │
   │  SHARD_00 .. 15    │  │  SESSION      │   │  PHOTOS            │
   │                    │  │  RATELIMIT    │   │  DOCUMENTS         │
   │                    │  │  CONFIG       │   │  EVIDENCE          │
   │                    │  │  SHARD_MAP    │   │  ARCHIVE           │
   │                    │  │  CREDENTIALS  │   │                    │
   └────────────────────┘  └───────────────┘   └────────────────────┘
              ▲
              │
   ┌──────────┴──────────┐        ┌─────────────────────────────┐
   │ Durable Objects     │        │ Queues（7）                 │
   │  DocumentSequencer  │        │  → コンシューマは同じ Worker │
   │  InspectionLock     │        └─────────────────────────────┘
   │  ReconciliationLock │
   └─────────────────────┘        ┌─────────────────────────────┐
                                  │ Cron Triggers（4 本）        │
                                  └─────────────────────────────┘
```

**外部**: Resend（メール）／PMS・スマートロック等の連携先。

---

## 2. シャーディング

```
                resolveShard(env, organizationId)
                            │
        ┌───────────────────┴───────────────────┐
        │ ① SHARD_MAP の shard:{orgId} を引く    │  ← 明示マッピング（移送済み）
        │ ② 無ければ fnv1a32(orgId) % SHARD_COUNT│  ← 既定
        └───────────────────┬───────────────────┘
                            ▼
                   SHARD_00 .. SHARD_15
```

- 全 binding を `apps/web/wrangler.toml` に**静的宣言**する。実行時に D1 を作らない。
- ローカルと preview は `SHARD_COUNT=1`。**同じコードが動く。**
- **`env.SHARD_XX` へ直接アクセスしない。** `getTenantDb(env, ctx)` のみ。
  ESLint の `no-direct-shard-access` が検出する。
- シャード番号を URL・レスポンス・ログへ出さない。
  出るのは運用者の CLI（`pnpm shards:usage` / `pnpm shards:move` / `pnpm db:migrate`）だけ。

### SHARD_MAP は専用の namespace

`shard:{organizationId}` は `SHARD_MAP` にのみ置く。**TTL を設定しない。**

このキーが失われても `resolveShard()` はエラーにならず、
`fnv1a32` のフォールバックへ**無警告で落ちる。** 移送済みの組織なら、
以後の読み書きが移送前のシャードへ向かい、**同一テナントのデータが
複数シャードに分裂する。**

`CONFIG` は設計上、一括更新・一括削除・TTL 失効の対象になるため同居させない。

---

## 3. テナント分離（三重防御）

RLS が無い代わりに 3 層で守る。**1 つでも欠けたら分離は成立しない。**

| 層 | 実体 | 破れたときの症状 |
|---|---|---|
| ① リポジトリ層の強制注入 | すべてのクエリが `organizationId` を付与し、施設スコープロールを絞る | 他組織・担当外施設の行が一覧に混ざる |
| ② ID の自己記述化 | `{orgShortId}__{prefix}_{ulid}`。DB 問い合わせ前に照合 | 他組織の ID を指定して 200 が返る |
| ③ CI の越境テスト | `tests/tenant-isolation/` 全表 4 パターン | ①② の退行に気づかない |

**拒否は 403 ではなく 404。** 403 は資源の存在を示唆する。

第 3 のテストは必ず「**同一シャードに落ちる組織ペア**」で行う。
異なるシャードでは物理的に到達不能で、テストとして意味を持たない。

---

## 4. Durable Objects（3 種）

| 名前空間 | 用途 | 粒度 |
|---|---|---|
| `DocumentSequencer` | 請求書・領収書の番号採番 | 組織 × 文書種別 × 年度 |
| `InspectionLock` | 検査開始の排他制御 | タスク |
| `ReconciliationLock` | 照合バッチの二重起動防止 | 施設 × 業務日 |

`.claude/rules/architecture.md` §4 は 4 種を挙げるが、
**`PropertyBoard`（客室ステータスのリアルタイム配信）はまだ宣言していない。**
盤面はポーリングで更新している。

**汎用データストアとして使わない。**

---

## 5. Queues（7）

| キュー | 用途 | コンシューマ |
|---|---|---|
| `pk-pdf-generation` | 日報・請求書・領収書・監査レポート | `consumers/pdf.ts` |
| `pk-evidence-export` | 証跡 ZIP | `consumers/evidenceExport.ts` |
| `pk-reconciliation` | 稼働照合バッチ | `consumers/reconciliation.ts` |
| `pk-rollup-update` | 集計テーブル更新（**再計算方式**） | `consumers/rollup.ts` |
| `pk-baseline-learning` | 消耗基準値の再計算 | `consumers/baselineLearning.ts` |
| `pk-notification` | メール・アプリ内通知 | `consumers/notification.ts` |
| `pk-archive-restore` | **3 種を運ぶ**（後述） | `consumers/archive.ts` ほか |

**すべてのコンシューマは冪等であること。** 3 回実行しても結果が変わらない。

### `pk-archive-restore` が運ぶ 3 種

`kind` で分岐する。**キューを増やしていない。**

| `kind` | 中身 | task |
|---|---|---|
| `ARCHIVE_EXPORT` | 年次アーカイブ（R2 へ書き出す） | P7-08 |
| `PHOTO_RETENTION` | 写真の保持期限（削除） | P7-10 |
| `ARCHIVE_RESTORE` | 退避データの復元（閲覧用） | P7-09 |

### コンシューマを足すときに触る 3 か所

1. `apps/web/src/index.ts` の `queue()` に 1 分岐
2. `apps/web/wrangler.toml` に `[[queues.consumers]]` を **4 環境ぶん**
3. `tests/toolchain/wrangler.spec.ts` の `IMPLEMENTED_CONSUMERS` に 1 行

---

## 6. Cron Triggers（4 本 / 無料枠は 5 本）

**cron 式は UTC。** 日本時間で書かない。

| 式（UTC） | JST | 走らせるもの |
|---|---|---|
| `0 17 * * *` | 02:00 毎日 | タスク自動生成（P1-03）／**稼働照合（P4-05）**／**写真の保持期限（P7-10）** |
| `*/10 * * * *` | 10 分ごと | 日報。**施設ごとの日締め時刻と突き合わせて絞る** |
| `0 18 * * 6` | 日曜 03:00 | ベースライン再計算（P3-09） |
| `0 19 28-31 * *` | 1 日 04:00 | 月次締め（P5-05）／**年次アーカイブ（P7-08。JST の 2 月 1 日だけ）** |

**同じ時刻の cron を 2 本置いても振り分けられない。**
だから 1 本の分岐に相乗りさせている。本数を増やすときは無料枠を数えること。

月末は cron に書き方が無いので 28〜31 日を並べ、
**JST の 1 日かどうかはハンドラが確かめる**（`isMonthlyCloseMoment()`）。

---

## 7. 業務日

```
businessDate = (現地時刻 − 施設の日締め時刻) の日付
既定の日締め時刻 = 05:00 Asia/Tokyo
```

**全ての日次集計は `businessDate` 基準。** カレンダー日を使わない。
DB には `YYYY-MM-DD` の text で保存する。

---

## 8. 集計

テナント横断・施設横断の集計は `dailyPropertyRollup` を使う。
**タスクテーブルへの直接集計・JOIN を書かない。**

更新は Queue コンシューマが**再計算方式**で行う。
インクリメント方式にしない（冪等性のため）。

---

## 9. パッケージ

```
apps/web/src/
  routes/m/        モバイル（清掃現場）
  routes/app/      PC 管理画面
  routes/api/v1/   REST API
  middleware/      session / tenant / resourceGuard
  consumers/       Queue コンシューマ
packages/
  db/              schema / repositories / router / migrations
  contracts/       Zod スキーマ（**API の入出力の唯一の定義**）
  engine/          稼働照合（純粋関数・依存ゼロ）
  billing/         料金計算（純粋関数・依存ゼロ）
  integrations/    外部連携アダプタ
  pdf/             帳票テンプレート
```

**`packages/engine` と `packages/billing` に DB・fetch・環境変数・
`Date.now()` を持ち込まない。** 現在時刻は `ctx.now` で注入する。

`packages/db/src/tenantMove.ts` と `shardUsage.ts` は
**node の CLI が import する**ため、Workers の型と schema を持ち込まない。

---

## 10. 関連

- 障害対応: `incident-response.md`
- 復旧: `recovery.md`
- デプロイ: `deploy.md`
- シャード移送: `shard-move.md`
