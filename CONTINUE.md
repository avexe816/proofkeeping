# CONTINUE

## 最終状態
- main HEAD: `83d218d` P6-12〜P6-15 (#68) の次
- 完了: **P7-06**（117 task）。**Phase 7 に着手した**
- 次: **P7-08（アーカイブとバッチ）/ P7-11（縮退運転の検証）**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P7-08.md` を読む（依存は P7-06。**満たされている**）
3. `docs/PK-SPEC-P0.md` §19.7（アーカイブ）と architecture.md を読む

### なぜ P7-01 から入らないのか
**P7-01 の依存は「P6 完了」で、満たされていない**（P6-06 / P6-10 / P6-11 が
人間待ち）。workflow.md §2「依存が満たされている最小番号」に従うと
**P7-06（依存は P0-20）**が入口になる。P7-06 は P7-07 / P7-08 / P7-11 の
依存でもあるので、Phase 6 を待たずに Phase 7 の後半へ進める。

**P7-01〜P7-05 は Phase 6 の完了待ち。** P7-04（Stripe）は加えて
**課金が発生する操作**（workflow.md §6 の停止条件）。

## 今回置いたもの（P7-06 シャード監視）

- `packages/db/src/shardUsage.ts` — 閾値 60/75/85% とレベル判定（純粋関数）
- `packages/db/src/shardUsageCollector.ts` — D1 を触る収集側
- `scripts/shard-usage.ts` / `pnpm shards:usage` — 運用者の CLI

### 覚えておくこと

- **シャード監視は画面にしない**（DECISIONS #157）。§4.3 MUST の
  「管理者向けダッシュボード」と CLAUDE.md §4 の「シャード番号を露出しない」が
  衝突しており、**運用者のロールが無い。** migration が番号を出力する
  先例（architecture.md §6）に合わせて CLI にした。
  **`shardUsage*.ts` をテナント向けの API・画面から呼ばないこと。**
- **`shardUsage.ts` に Workers の型を持ち込まない。** node の CLI が
  import するので、`D1Database` を書くと型検査が落ちる。D1 を触る側は
  `shardUsageCollector.ts`。
- **測れていない値を `ok` に混ぜない**（#158）。`unknown` を `ok` より
  重い側に置いてある。
- **ルートに script を足したら `tests/toolchain/workspace.spec.ts` の
  `EXPECTED_ROOT_SCRIPTS` に 1 行足す。** 実体のない script を置かせない検査。

## 人間待ちの 3 task（前提が揃えば即着手できる）

| task | 要るもの | 受け皿の状況 |
|---|---|---|
| P6-06 PMS アダプタ 1 社 | 実接続する PMS の確定と接続情報 | アダプタ interface（P6-03）・マッピング（P6-05）・リトライ（P6-07）は揃っている |
| P6-10 Web Push | VAPID 鍵 3 つ（`wrangler secret put`） | `push_subscription` 表・`listDeliverablePushMembershipIds()`・`pushAvailable` の差し込み口が揃っている |
| P6-11 LINE 通知 | LINE 公式アカウントのチャネルとトークン | **方式は (a) Messaging API で確定**（2026-08-15）。`resolveChannels()` が `LINE` を返す形になっている |

## 今回置いたもの（P6-12〜P6-15）

- `lib/auth/apiKey.ts` / `middleware/apiKey.ts` / `routes/api/v1/public.ts` /
  `routes/api/v1/apiKeys.ts` — 公開 API 一式
- `packages/integrations/src/core/outboundDelivery.ts` /
  `consumers/outboundWebhook.ts` — 送信 Webhook
- `routes/app/integrationSettings.tsx` — W-13 / W-24
- `docs/PK-API.md` — 顧客向けの接続手順

### 覚えておくこと

- **公開 API で `assertPermission()` を呼ばない**（DECISIONS #151）。
  `TenantContext.role` は施設スコープを効かせるためだけの値。
  **`public.spec.ts` がソースを走査して固定している**ので、
  1 か所でも呼ぶと落ちる。
- **平文のトークンを再表示する口を作らない**（§6.1 MUST）。
  `apiKeys.ts` に `issued.token` が 1 回しか現れないことも spec が数えている。
- **公開 API は ProofKeeping の ID だけ**（#152）。外部 ID の変換は
  汎用 Webhook の担当。
- **送信 Webhook は 2xx だけを成功とする。** 3xx を成功に数えると、
  リダイレクト先へ署名付きの本文が飛ぶ。
- **UI 文言に「失敗」を書かない。** 禁止語（`forbidden-words-list.js`）。
  W-13 では「取得できなかった」「取込不可」に言い換えた。
- **レート制限を使うテストは時計を固定する。** 窓が `floor(now/60000)` なので、
  実時計のままループすると分の境界で数 % 落ちる（`auth.spec.ts` の注記）。

## 前回置いたもの（P6-09 通知基盤）

- `lib/notification/events.ts` — **§5.1 の表そのもの（10 件）。**
- `lib/notification/routing.ts` — `resolveChannels()`（純粋）。
- `consumers/notify.ts` — `pk-notification` に相乗りする `kind: "NOTIFY"`。
- **`IN_APP` は「外へは送らない」**（DECISIONS #146）。
- **`CLEANER` の境界は表と定数の二重**（#147）。
- 繋いだ producer は `integration.error` / `finding.high` / `invoice.issued`。

## 申し送り

### 人間の作業
1. **VAPID 鍵の生成と設定**（P6-10 の前提）。Web Push の署名に要る。
   `wrangler secret put` で `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
   `VAPID_SUBJECT`（`mailto:` か URL）。**無いと P6-10 に着手できない。**
2. **LINE 公式アカウントのチャネル発行とアクセストークンの設定**（P6-11 の前提）。
   **方式は (a) Messaging API で確定済み**（2026-08-15）。
3. **最初に実接続する PMS を確定する**（§11 の未決事項 1）。**P6-06 の前提。**
   決まるまで P6-06 は着手しない（§3.2 MUST「想定で作らない」）。
4. **スマートロックの対象機種を確定する**（§11 の未決事項 2）。
   §8.2 の「R002 / R013 が実データで動作する」の検証に要る。
5. `RESEND_WEBHOOK_SECRET` の設定（`wrangler secret put`）。未設定だと 401。
6. 実機で 1 通送って Resend の webhook payload を確かめる（#077）。
7. 和文フォントの配置（P2-14 から継続）。無いと PDF が作られない。
8. **`pk-rollup-update` キューの作成**（4 環境）。宣言は `wrangler.toml` に有り。

### 積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** P5 / P6 は技術的に依存しない。
- **P6-06 PMS アダプタ 1 社。** 上記 1 が決まるまで。

### 未解決の問い（新しい順）
- #095 シャード監視の「ダッシュボード」をどこへ出すか → CLI 止まり
- #094 送信 Webhook を管理する画面と API が仕様に無い → 配信側だけ実装
- #093 送信 Webhook の停止を知らせるイベントが §5.1 に無い → `integration.error`
- #092 `/rooms` に対応するスコープが §6.2 に無い → `tasks:read` に寄せた
- #091 通知が届いたかを事後に追えない → 当面は運用で受ける
- #090 取引先（組織の外）への通知の宛先を引く経路が無い → 送っていない
- #089 アプリ内通知を貯める表が無い → `IN_APP` は既存の画面が正
- #088 「再接続テスト」が実際には接続していない → 状態の復帰と記録だけ
- #087 未マッピングの外部 ID を個別に出せない → 件数のみ。貼り付けで補う
- #086 Bearer トークンから組織を解決する手段が無い → P6-12 が決める
- #085 `propertyId = null` の連携は `uq_integration` が効かない → 作成側で防ぐ
- #084 請求状況は税込・施設別収支は税抜 → 見出しに明記。合計は一致しない
- #083 「受託施設」を判定する列（`orgType`）が無い → `VENDOR_PLAN` の契約で絞る
- #082〜#063 は P5 以前（DECISIONS / CONTINUE の履歴を参照）

### 直近の設計判断
- #158 測れていない使用率を `ok` に混ぜない
- #157 シャード監視は運用者の CLI として置く（画面にしない）
- #155 送信 Webhook のリトライ表を受信側と分ける
- #154 W-24（同期ログ）を W-13 と同じ画面に置く
- #153 公開 API からの稼働記録は `PMS_API` を名乗る
- #152 公開 API は ProofKeeping の ID だけを受け取る
- #151 公開 API では `assertPermission()` を呼ばない
- #150 API キーのトークンに組織短縮 ID を埋める
- #149 業務通知を `document_delivery` に記録しない
- #148 通知の重複を `CONFIG` KV の `dedupeKey` で止める
- #147 `CLEANER` の境界を表と定数で二重に締める
- #146 `IN_APP` は「外へは送らない」を意味する
- #145 「再接続テスト」は当面 状態の復帰と記録だけを行う
- #144 W-23 の外部システム側一覧は、当面 利用者の貼り付けで受ける
- #143 連携設定とマッピングは `OWNER` / `ORG_ADMIN` だけに開く
- #142 自動マッピングは部屋番号の完全一致だけで結ぶ
- #141 サーキットブレーカーを P6-06（実 PMS）より先に置く
- #140 物理シグナルの取込は `pk-reconciliation` に相乗りする
