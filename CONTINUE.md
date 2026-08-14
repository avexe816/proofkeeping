# CONTINUE

## 最終状態
- main HEAD: `c8448ba` P6-01〜P6-04 外部連携の受信側 (#64) の次
- 完了: **P6-05 / P6-07 / P6-08**（111 task）
- **P6-06 は ⏳ 人間待ち**（実接続する PMS が未確定）
- 次: **P6-09（通知基盤 IN_APP → EMAIL）から P6-15 まで**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P6-09.md` を読む（依存は P6-01。**満たされている**）
3. `.claude/rules/ui-writing.md` §6（通知）と `docs/PK-SPEC-P6.md` §5 を読む
4. P6-09 → P6-10 → P6-11 → P6-12 → P6-13 → P6-14 → P6-15 の順

## 今回置いたもの

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

## 覚えておくこと

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
1. **最初に実接続する PMS を確定する**（§11 の未決事項 1）。**P6-06 の前提。**
   決まるまで P6-06 は着手しない（§3.2 MUST「想定で作らない」）。
2. **スマートロックの対象機種を確定する**（§11 の未決事項 2）。
   §8.2 の「R002 / R013 が実データで動作する」の検証に要る。
3. `RESEND_WEBHOOK_SECRET` の設定（`wrangler secret put`）。未設定だと 401。
4. 実機で 1 通送って Resend の webhook payload を確かめる（#077）。
5. 和文フォントの配置（P2-14 から継続）。無いと PDF が作られない。
6. **`pk-rollup-update` キューの作成**（4 環境）。宣言は `wrangler.toml` に有り。

### 積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** P5 / P6 は技術的に依存しない。
- **P6-06 PMS アダプタ 1 社。** 上記 1 が決まるまで。

### 未解決の問い（新しい順）
- #088 「再接続テスト」が実際には接続していない → 状態の復帰と記録だけ
- #087 未マッピングの外部 ID を個別に出せない → 件数のみ。貼り付けで補う
- #086 Bearer トークンから組織を解決する手段が無い → P6-12 が決める
- #085 `propertyId = null` の連携は `uq_integration` が効かない → 作成側で防ぐ
- #084 請求状況は税込・施設別収支は税抜 → 見出しに明記。合計は一致しない
- #083 「受託施設」を判定する列（`orgType`）が無い → `VENDOR_PLAN` の契約で絞る
- #082〜#063 は P5 以前（DECISIONS / CONTINUE の履歴を参照）

### 直近の設計判断
- #145 「再接続テスト」は当面 状態の復帰と記録だけを行う
- #144 W-23 の外部システム側一覧は、当面 利用者の貼り付けで受ける
- #143 連携設定とマッピングは `OWNER` / `ORG_ADMIN` だけに開く
- #142 自動マッピングは部屋番号の完全一致だけで結ぶ
- #141 サーキットブレーカーを P6-06（実 PMS）より先に置く
- #140 物理シグナルの取込は `pk-reconciliation` に相乗りする
