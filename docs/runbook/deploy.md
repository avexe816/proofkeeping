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

| 環境 | Worker 名 | シャード |
|---|---|---|
| local | `pk-local` | 1（miniflare） |
| preview | PR ごと（`pk-pr-{n}`） | 1 |
| staging | `pk-staging` | 16 |
| production | `pk-production` | 16 |

**preview は `CLOUDFLARE_API_TOKEN` が未設定なら何もせずに抜ける。**
fork からの PR で常に赤くならないようにするため。

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
