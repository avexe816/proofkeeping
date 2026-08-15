# CONTINUE

## 最終状態
- main HEAD: `b098561` の次（P7-08 / P7-11 の PR）
- 完了: **P7-08 / P7-11**（119 task）
- 次: **P7-07（テナント移送）/ P7-09（アーカイブ閲覧）/ P7-10（R2 保持期間管理）**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P7-09.md` を読む（**P7-08 が置いた `archive_manifest` が起点**）
3. 依存を確認して実装開始

**P7-01〜P7-05 は飛ばしたまま。** 人間の指示（2026-08-15）で、
Phase 6 の完了待ちのため後回しにしている。P7-04（Stripe）は加えて
**課金が発生する操作**（workflow.md §6 の停止条件）。

## 今回置いたもの（P7-08 / P7-11）

### P7-08 年次アーカイブ

| ファイル | 役割 |
|---|---|
| `packages/db/src/archivePolicy.ts` | 対象と除外（**純粋**）。既定は「退避しない」 |
| `packages/db/migrations/0019_p7_08_archive_manifest.sql` | `archive_manifest` 表（追加のみ） |
| `packages/db/src/repositories/archive.ts` | 記録と、退避する行の読み取り |
| `apps/web/src/consumers/archive.ts` | JSONL → SHA-256 → gzip → R2 → manifest |
| `apps/web/src/lib/archive/dispatch.ts` | 年次の投入（月次締めの cron に相乗り） |

### P7-11 縮退運転の検証

| ファイル | 役割 |
|---|---|
| `apps/web/src/lib/degradation/priority.ts` | §5.2 の優先度表（**純粋**） |
| `apps/web/src/lib/degradation/priority.spec.ts` | 検証 33 件（ソース走査を含む） |

### 覚えておくこと

- **退避は「削除」ではない**（DECISIONS #159）。`consumers/archive.ts` は
  D1 に `DELETE` を発行しない。§19.7 の手順 3・4 は別工程で、まだ task が
  起票されていない。**そのぶんシャードは小さくならない。**
  実装するときは `archive_manifest` の `sha256` と R2 の写しを
  突き合わせてから外すこと。
- **`repositories/archive.ts` と `consumers/archive.ts` に `delete` を
  含む名前を置かない。** spec が両方を走査している（P7 固有の絶対ルール）。
- **§19.7 の 9 表のうち退避できるのは 5 表**（OPEN_QUESTIONS #096）。
  `task_time_log` / `task_checklist_result` / `inspection` /
  `inspection_item_result` は `businessDate` 列を持たない。
  **`ARCHIVABLE_TABLES`（9 表）と `DIRECTLY_ARCHIVABLE_TABLES`（5 表）を
  取り違えないこと。** 書き出すのは後者。
- **年次の起動は月次締めの cron に相乗り**（#160）。JST の 2 月 1 日だけ。
  対象年は実行年 − 2。**cron を増やさない。**
- **Queue のコンシューマを足したら 3 か所を同時に触る。**
  `apps/web/src/index.ts` の `queue()` に 1 分岐、`wrangler.toml` に
  `[[queues.consumers]]` を 4 環境ぶん、`tests/toolchain/wrangler.spec.ts` の
  `IMPLEMENTED_CONSUMERS` に 1 行。
- **リポジトリ関数を足したら `repositories.spec.ts` の `INVOCATIONS` に
  1 行足す。** 登録漏れを検出する spec がある。
- **優先度で機能を止める実行時のコードを書かない**（#161）。
  §5.2 は「壊れたときにどこから諦めるか」の表。平常時の分岐を増やすと
  優先度 1 がその分だけ壊れやすくなる。
- **`schemaVersion` 不一致の 503 middleware はまだ無い**（§5.3 MUST）。
  実装するときは **4xx で塞がないこと。** 4xx は `verdictOf()` が
  `GIVE_UP` にするので、オフラインキューに吸収されない。

## 人間待ちの 3 task（前提が揃えば即着手できる）

| task | 要るもの | 受け皿の状況 |
|---|---|---|
| P6-06 PMS アダプタ 1 社 | 実接続する PMS の確定と接続情報 | **未確定。飛ばしたまま進める**（人間の指示 / 2026-08-15） |
| P6-10 Web Push | VAPID 鍵 3 つ（`wrangler secret put`） | **人間が設定中。**終わったらここから再開 |
| P6-11 LINE 通知 | LINE 公式アカウントのチャネルとトークン | **方式は (a) Messaging API で確定**（2026-08-15） |

## 申し送り

### 人間の作業
1. **VAPID 鍵の生成と設定**（P6-10 の前提）。**設定中。**
   `wrangler secret put` で `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
   `VAPID_SUBJECT`（`mailto:` か URL）。
2. **LINE 公式アカウントのチャネル発行とアクセストークンの設定**（P6-11 の前提）。
   **方式は (a) Messaging API で確定済み。**
3. **最初に実接続する PMS を確定する**（§11 の未決事項 1）。**P6-06 の前提。**
4. **スマートロックの対象機種を確定する**（§11 の未決事項 2）。
5. `RESEND_WEBHOOK_SECRET` の設定（`wrangler secret put`）。未設定だと 401。
6. 実機で 1 通送って Resend の webhook payload を確かめる（#077）。
7. 和文フォントの配置（P2-14 から継続）。無いと PDF が作られない。
8. **`pk-rollup-update` キューの作成**（4 環境）。宣言は `wrangler.toml` に有り。
9. **`pk-archive-restore` キューの作成**（4 環境）。宣言は `wrangler.toml` に有り。
   **P7-08 のコンシューマは宣言済みなので、作成しないと年次の投入が落ちる。**
10. **`ARCHIVE` R2 バケットの作成**（4 環境）。宣言は `wrangler.toml` に有り。

### 仕様の版上げ（P7 完了後にまとめて / 人間の指示）
- §4.3 「シャード使用率を管理者向けダッシュボードで常時表示」→ CLI 止まり（#157）
- §19.7 の 9 表 → 実際に退避できるのは 5 表（OPEN_QUESTIONS #096）
- §19.7 の手順 3・4（DELETE / VACUUM）→ 別工程（DECISIONS #159）

### 積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** P5 / P6 は技術的に依存しない。
- **P6-06 PMS アダプタ 1 社。** 上記 3 が決まるまで。

### 未解決の問い（新しい順）
- #096 §19.7 の 9 表のうち 4 表は `businessDate` を持たない → 5 表だけ退避
- #095 シャード監視の「ダッシュボード」をどこへ出すか → CLI 止まり
- #094 送信 Webhook を管理する画面と API が仕様に無い → 配信側だけ実装
- #093 送信 Webhook の停止を知らせるイベントが §5.1 に無い → `integration.error`
- #092 `/rooms` に対応するスコープが §6.2 に無い → `tasks:read` に寄せた
- #091 通知が届いたかを事後に追えない → 当面は運用で受ける
- #090 取引先（組織の外）への通知の宛先を引く経路が無い → 送っていない
- #089 アプリ内通知を貯める表が無い → `IN_APP` は既存の画面が正
- #088 「再接続テスト」が実際には接続していない → 状態の復帰と記録だけ
- #087 未マッピングの外部 ID を個別に出せない → 件数のみ。貼り付けで補う
- #086 Bearer トークンから組織を解決する手段が無い → P6-12 が決めた
- #085 `propertyId = null` の連携は `uq_integration` が効かない → 作成側で防ぐ
- #084 請求状況は税込・施設別収支は税抜 → 見出しに明記。合計は一致しない
- #083 「受託施設」を判定する列（`orgType`）が無い → `VENDOR_PLAN` の契約で絞る
- #082〜#063 は P5 以前（DECISIONS / CONTINUE の履歴を参照）

### 直近の設計判断
- #161 縮退運転の「検証」は仕組みを足さずに性質を固定する
- #160 年次アーカイブの起動を月次締めの cron に相乗りさせる
- #159 退避（R2 への書き出し）と D1 からの取り外しを分ける
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
