# デプロイ手順

**版**: v1.0（2026-08-15）
**対象**: 社内（運用者・開発者）
**仕様**: docs/PK-SPEC-P7.md §7.2

**16 シャードのマイグレーションを含む。** ここを間違えると
`schemaVersion` の不一致が起き、組織によって API が成功したり
失敗したりする状態になる（`incident-response.md` §1.2）。

---

## 0. 順序

```
   CI（3 ジョブ）が緑
        ↓
   ① マイグレーションを先に当てる（後方互換のみ）
        ↓
   ② Worker をデプロイする
        ↓
   ③ /api/health を確認する
```

**マイグレーションが先。コードが後。**
後方互換の変更しか入れない規則なので、旧コードは新スキーマ上で動く。
逆順にすると、新コードが未追加の列を読んで落ちる。

---

## 1. デプロイ前

### 1.1 CI の必須ジョブ（3 本 / 並列）

| ジョブ | 中で走る検査（この順） |
|---|---|
| `lint-typecheck` | ESLint（カスタムルールを含む）→ `tsc --noEmit` |
| `test` | 禁止語の grep 2 種 → `drizzle-kit check` → `gitleaks`（`fetch-depth: 0`）→ テナント越境 → Vitest |
| `build-e2e` | ビルド → E2E → preview デプロイ（PR のみ） |

**3 本すべてが緑でなければデプロイしない。**

**検査の中身は 9 ジョブだった頃と同じ**（DECISIONS #185）。まとめたのは
Actions の無料枠が尽きたため。**落ちたステップ名はそのまま出る**ので、
どの検査で落ちたかは一覧で分かる。

### 1.2 変更の性質を確かめる

| 種類 | 可否 |
|---|---|
| 列の追加（nullable / default 付き） | **可** |
| 表の追加 | **可** |
| 索引の追加 | 可（大きな表では時間がかかる） |
| 列の削除・リネーム・型変更 | **単一リリースでは不可**（3 段階に分ける） |

破壊的変更は 3 段階。
**① 新列を足す → ② 両方へ書き、新列から読む → ③ 旧列を消す（次リリース）。**

### 1.3 未適用の検出

```bash
pnpm db:migrate --env production --check
```

**適用は行わない。** 何が未適用かだけを出す。

---

## 2. マイグレーション

```bash
pnpm db:migrate --env production
```

- **16 シャードへ順次実行する。**
- **1 つ失敗したら以降を中止し、シャード番号を出力する。**
  途中まで当たった状態で止まる。**それでよい。**
  無理に進めると、どこまで当たったかが分からなくなる。
- 失敗したら、その番号のシャードだけを調べてから再実行する。
  適用済みのシャードは再実行しても二重に当たらない。

適用後に必ず確認する。

```bash
curl -s https://<host>/api/health | jq '.shards'
# schemaVersionConsistent: true であること
```

**false のままデプロイへ進まない。**

---

## 3. デプロイ

```bash
pnpm --filter @pk/web build
wrangler deploy --env production
```

### 環境

| 環境 | Worker 名 | シャード | 公開 URL | デプロイ |
|---|---|---|---|---|
| local | `pk-local` | 1（miniflare） | なし | `pnpm dev` |
| preview | PR ごと（`pk-pr-{n}`） | 1 | なし（`workers_dev = false`） | PR で自動 |
| staging | `pk-staging` | 2 | `https://pk-staging.<サブドメイン>.workers.dev` | **main への push で自動** |
| production | `pk-prod` | 16 | 独自ドメイン | 手動 |

**preview と staging は `CLOUDFLARE_API_TOKEN` が未設定なら何もせずに抜ける。**
fork からの PR で常に赤くならないようにするため。

**staging だけが `workers_dev = true`。** 継承されるキーなので、
[env.*] に書かないと top-level の `false` が効き、**URL を持たない Worker**
が出来上がる。理由は `apps/web/wrangler.toml` の `[env.staging]` に書いてある。

### 秘密の設定（初回・変更時のみ）

```bash
wrangler secret put RESEND_API_KEY --env production
wrangler secret put RESEND_WEBHOOK_SECRET --env production
wrangler secret put VAPID_PUBLIC_KEY --env production
wrangler secret put VAPID_PRIVATE_KEY --env production
wrangler secret put VAPID_SUBJECT --env production
```

**`wrangler.toml` に秘密を書かない。** `gitleaks` が落とす。

---

## 3.5 staging の初期構築（1 回だけ）

**`docs/tasks/P0-02.md` の Cloudflare リソース作成が前提。** 以下は
staging ぶんだけを抜き出した手順。**すべて人間の端末で実行する。**

### ① リソースを作る

```bash
cd apps/web

# D1（2 本）
wrangler d1 create proofkeeping-shard-00-staging
wrangler d1 create proofkeeping-shard-01-staging

# KV（5 本）
wrangler kv namespace create SESSION      --env staging
wrangler kv namespace create RATELIMIT    --env staging
wrangler kv namespace create CONFIG       --env staging
wrangler kv namespace create CREDENTIALS  --env staging
wrangler kv namespace create SHARD_MAP    --env staging

# R2（4 本）
wrangler r2 bucket create pk-photos-staging
wrangler r2 bucket create pk-documents-staging
wrangler r2 bucket create pk-evidence-staging
wrangler r2 bucket create pk-archive-staging

# Queues（7 本）
for q in pdf-generation evidence-export reconciliation rollup-update \
         baseline-learning notification archive-restore; do
  wrangler queues create "pk-${q}-staging"
done
```

### ② 出力された ID を `wrangler.toml` へ差し替える

```bash
grep -n "TODO-P0-02-未作成-STAGING" apps/web/wrangler.toml
```

D1 は 2 件、KV は 5 件。**推測した UUID を書かないこと。**

### ③ 秘密を入れる

```bash
cd apps/web
wrangler secret put SESSION_SECRET --env staging        # 必須。無いと 503
wrangler secret put STAGING_SEED_TOKEN --env staging    # シード投入の鍵
wrangler secret put CREDENTIAL_ENCRYPTION_KEY --env staging
wrangler secret put VAPID_PUBLIC_KEY --env staging
wrangler secret put VAPID_PRIVATE_KEY --env staging
wrangler secret put VAPID_SUBJECT --env staging
```

**`RESEND_API_KEY` を staging へ置かない。** 置かなければメールの
`fetch` そのものが飛ばない（DECISIONS #188）。**外部送信を止める操作は
「鍵を置かないこと」。**

設定済みの**名前だけ**を確認する（値は表示されない）。

```bash
wrangler secret list --env staging
```

### ④ migration を流す

```bash
pnpm db:migrate --env staging --check   # 未適用の検出だけ
pnpm db:migrate --env staging           # 適用
```

**CI は migration を流さない。** 後方互換でない変更が、気づく前に
適用されるのを避けるため。

### ⑤ 初回デプロイ

```bash
pnpm --filter @pk/web build
cd apps/web && wrangler deploy --env staging
```

出力された `https://pk-staging.<サブドメイン>.workers.dev` を
**`[env.staging.vars]` の `APP_BASE_URL` へ書き戻す**（今は
`https://staging.proofkeeping.example` のプレースホルダ）。
案内カードの QR とメールのリンクがこの値を使う。

### ⑥ テスト用の組織とアカウントを作る

```bash
curl -X POST "https://pk-staging.<サブドメイン>.workers.dev/api/v1/dev/seed" \
  -H "content-type: application/json" \
  -H "x-pk-seed-token: <STAGING_SEED_TOKEN に入れた値>" \
  -d '{"ownerPassword":"<10 文字以上・英大小・数字>"}'
```

応答の `orgShortId` でログインする（`/m/login` と `/app/login`）。
**`STAGING_SEED_TOKEN` を設定していなければ 404。** 既定は閉じている。

以後は main へマージするたびに同じ URL へ自動反映される。**②〜④ は
リソースを増やしたときだけ**やり直す。

---

## 4. デプロイ後

1. `GET /api/health` が `state: "ok"`。
2. 現場の主要導線を 1 本通す（ログイン → 本日のタスク → 開始 → 完了）。
   **優先度 1 の経路を最初に見る。**
3. Workers のログで 5xx が増えていないこと。
4. キューが詰まっていないこと（`queues` が `ok`）。

**清掃時間帯（06:00–20:00）にデプロイしない。**
稼働率の目標が 99.9% で、同じ停止時間の重みが違う。

---

## 5. ロールバック

```bash
wrangler rollback --env production
```

**コードは戻せる。スキーマは戻せない。**
だから後方互換の変更しか入れない。旧コードは新スキーマ上で動く。

| 症状 | 対応 |
|---|---|
| 新機能が壊れている | `wrangler rollback`。スキーマはそのまま |
| マイグレーションが途中で止まった | **戻さない。** 残りを当てて揃える（`incident-response.md` §1.2） |
| データが壊れた | ロールバックでは直らない。`recovery.md` へ |

**マイグレーションを「戻す」操作を用意していない。**
戻すマイグレーションは、当たっているシャードと当たっていない
シャードが混在した状態で走ることになり、不一致を増やす。

---

## 6. 定期の確認

| 頻度 | 見るもの |
|---|---|
| 毎日 | `/api/health` |
| 週次 | `pnpm shards:usage --env production` |
| 月次 | キューの滞留・失敗したメッセージ |
| 四半期 | 復旧訓練（`recovery.md` §5） |

---

## 7. まだ整っていないこと

**運用を始める前に、これらが埋まっていることを確認すること。**

| 項目 | 状態 |
|---|---|
| production / staging の D1 16 本・KV・R2・Queue の作成 | **未作成**（`wrangler.toml` は宣言済み） |
| `pk-rollup-update` / `pk-archive-restore` キュー | **未作成**（4 環境ぶん） |
| `ARCHIVE` R2 バケット | **未作成**（4 環境ぶん） |
| 和文フォントの配置 | **未配置**（無いと PDF が 1 枚も作られない） |
| Sentry などへのエラー集約 | **未実装**（採用可否が未決） |
| `schemaVersion` 不一致で書き込みを 503 にする middleware | **未実装** |
| preview の D1 / KV / R2 / Queue | **未作成**（`e2e` が回らない） |

---

## 8. 関連

- 障害対応: `incident-response.md`
- 復旧: `recovery.md`
- アーキテクチャ: `architecture.md`
