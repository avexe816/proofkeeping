# CONTINUE

## 最終状態
- main HEAD: `1bf85b4` P6-05・P6-07・P6-08 (#66) の次
- 完了: **P6-09**（112 task）
- **P6-06 は ⏳ 人間待ち**（実接続する PMS が未確定）
- 次: **P6-10（Web Push）から P6-15 まで**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P6-10.md` を読む（依存は P6-09。**満たされている**）
3. `docs/PK-SPEC-P6.md` §5.2 と `.claude/rules/ui-writing.md` §6 を読む

### P6-10 に入る前に
- **VAPID 鍵が要る。** Web Push の署名（ES256 の JWT）と `aes128gcm` の
  ペイロード暗号化を WebCrypto で自前実装することになる。`web-push` は
  Workers で動かない。**鍵の生成と `wrangler secret put` は人間の作業。**
  接続情報が要る task なので、**着手前に止まって確認すること**
  （workflow.md §2）。
- 受け皿は既にある: `push_subscription` 表（P6-01）、
  `listDeliverablePushMembershipIds()`（P6-09）、
  `resolveChannels()` の `pushAvailable`（いまは固定で `false`）。
  **P6-10 は購読の登録・失効・送信と、`pushAvailable` の差し替えだけ。**
- `PUSH_FAILURE_LIMIT = 3`（§5.2 MUST）は `packages/db` に置いてある。

### P6-11（LINE）に入る前に
- **§5.4 と §11 の未決事項 5 が食い違っている。** §5.4 は「LINE 公式
  アカウント（Messaging API）」と方式を書いているのに、§11 は
  「LINE 公式アカウントで行うか、LINE WORKS を対象にするか」を未決として
  挙げている。**着手前に人間に確認すること**（workflow.md §6 の停止条件）。

## 今回置いたもの（P6-09 通知基盤）

- `lib/notification/events.ts` — **§5.1 の表そのもの（10 件）。**
- `lib/notification/routing.ts` — `resolveChannels()`（純粋）。
  ①相手 ②既定/設定 ③`PUSH` のフォールバック ④静音時間 の順。
- `packages/db/src/repositories/notification.ts` — 宛先・設定・購読の読み。
- `consumers/notify.ts` — `pk-notification` に相乗りする `kind: "NOTIFY"`。

### 覚えておくこと

- **`IN_APP` は「外へは送らない」**（DECISIONS #146）。§2 に通知を貯める表が
  無く、§5.2 MUST が「必ず画面内でも同じ情報を提示する」と定めている。
  `outboundChannelsOf()` が落とす。**表を足したくなったら #146 を先に読む。**
- **`CLEANER` の境界は表と定数の二重**（DECISIONS #147）。
  `events.ts` の `audience` を編集しただけでは清掃スタッフへ流れない。
  **この重ね掛けを「冗長だから」と外さないこと。**
- **重複は `CONFIG` KV の `dedupeKey`**（DECISIONS #148）。鍵は**投入側が
  決める**。D1 を引く前に見て、**送り終えてから置く。**
- **業務通知を `document_delivery` に記録しない**（DECISIONS #149）。
  あれは電子取引の記録そのもの（billing.md §2）。
- `notify()` は**失敗を握りつぶす。** 通知は補助機能（§1.3 MUST）で、
  投入に失敗しても業務を止めない。

### 繋いだ producer は 2 つ
`integration.error`（サーキットブレーカーが開いた回だけ）と
`finding.high`（照合が新しく差異を足した回だけ）。**残り 8 つは、それぞれの
業務フロー側の task が `notify()` を 1 回呼べば動く。**

## 前回置いたもの（P6-05 / P6-07 / P6-08）

### P6-05 マッピングと W-23
`/app/settings/integrations/:integrationId/mappings`。

- **突き合わせは部屋番号の完全一致だけ**（DECISIONS #142）。
  `305` と `0305` を結ばない。§7.2 の見本がその組を「手動設定」と
  描いており、仕様が前ゼロを一致とみなしていない。外したときに起きるのは
  「302 号室の稼働記録が 303 号室に入る」ことで、誤りの向きが悪すぎる。
- 同じ番号が片側に 2 つ以上あれば**どちらも結ばない**（`ambiguous`）。
- **外部システム側の一覧は利用者の貼り付け**（DECISIONS #144）。アダプタが
  1 つも無いので `listRooms()` を呼べない。アダプタが入ったら入力元を
  差し替えるだけ（`autoMapRooms()` はそのまま）。
- 権限 `integration.read` / `integration.write` を新設。`OWNER` / `ORG_ADMIN`
  だけ、`AUDITOR` は読み取り（DECISIONS #143）。

### P6-07 リトライとサーキットブレーカー
- **P6-06 を待たずに実装した**（DECISIONS #141）。§3.4 の判断は
  `consecutiveFailures` と失敗回数しか見ず、アダプタを参照しない。
- 5 分 → 15 分 → 60 分、4 回目で打ち止め。Queue の `retry({ delaySeconds })`。
- `consecutiveFailures >= 5` で `status = ERROR`。**`SUSPENDED` は上書きしない。**
- `openCircuitIfNeeded()` は「**この回で開いたか**」を返す。毎回の失敗で
  `integration.error` を送らせないため（通知は P6-09 の仕事）。
- `POST /api/v1/integrations/:id/reconnect` で閉じる。**まだ実際には
  接続していない**（OPEN_QUESTIONS #088 / DECISIONS #145）。

### P6-08 スタッフキー除外と R002 検証
- `packages/engine/src/reconciliation/staffKey.ts`。R002 と R013 が共有。
- **§4.4 の方法 2（清掃の start / complete の前後 10 分）を既定**にした。
  方法 1（`STAFF_KEY` / `MASTER_KEY`）も併せて掛ける。
- `TaskFact.startedAt` を足した。**`completedAt` から逆算しない。**
- **`actorType` 不明の解錠を数に入れ、確信度を 25 下げる**（§4.3）。
  数えない実装だと、鍵の種別を返さない機種でルールが一度も立たない。
  **不明を `GUEST_KEY` に書き換えていない。**
- 減点で `matchedSignals` を増やさない。あの件数は §1.3 の
  「単一シグナルで 80 以上を出さない」を解く鍵で、増やすと
  **不明であることが確信度の上限を上げる**という逆立ちが起きる。
- `RECONCILIATION_ENGINE_VERSION` を `1.1` → `1.2`。**判定が変わった。**

### 前回から覚えておくこと

- **`integration` を照合バッチと CSV 取込から読まない。** §1.2 / §3.4 MUST の
  「ERROR でも照合が完走する」「手動 CSV 取込が常に使える」は、この
  依存の不在で成り立っている。`apps/web/src/consumers/circuitBreaker.spec.ts`
  が構造として検査しているので、読むコードを足すと落ちる。
- **連携先固有の分岐を `packages/integrations` の外に書かない**（§1.1 MUST）。
  同じ spec が `vendorCode ===` を走査している。
- **通知は業務の必須要素にしない**（ui-writing.md §6）。P6-09〜P6-11 で
  いちばん効く制約。`CLEANER` に届いてよいのは `task.rework_assigned` だけ。

## 申し送り

### 人間の作業
1. **VAPID 鍵の生成と設定**（P6-10 の前提）。Web Push の署名に要る。
   `wrangler secret put` で `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
   `VAPID_SUBJECT`（`mailto:` か URL）。**無いと P6-10 に着手できない。**
2. **LINE の方式を決める**（P6-11 の前提）。§5.4 は「LINE 公式アカウント
   （Messaging API）」と書くが、§11 の未決事項 5 は LINE WORKS も候補に
   挙げている。**仕様の 2 か所が食い違っている。**
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
