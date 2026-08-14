# CONTINUE

## 最終状態
- main HEAD: P5-10 のマージ後
- 完了: **Phase 0〜4 と P5-01〜P5-10**（P4-08 を除く）
- 次: **P5-11（検索機能・電帳法対応）**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P5-11.md` を読む（依存 P5-01 のみ。独立して進められる）
3. 番号順に進める（P5-08 → P5-09 → P5-10 → P5-11 → P5-12 …）

### P5 の依存関係
```
P5-01 ✅ → P5-02 ✅ → P5-03 ✅ → P5-04 ✅ ┬→ P5-05 ✅ → P5-12 → P5-13
                                            │              └→ P5-14 → P5-15
                                            └→ P5-06 ✅ → P5-07 ✅ ┬→ P5-08
                                                                    ├→ P5-09 ←次

                                                                    └→ P5-10
P5-01 → P5-11（検索・電帳法対応。独立して進められる）
```

## 申し送り

### ⚠ いまは請求書を出せない（P5-12 待ち）
**常に `AGREED` 必須**にした（人間の判断 / OPEN_QUESTIONS #074）。
合意（`AGREE`）の口は **P5-12** にしか無いので、それまで現場では
請求書が 1 通も出せない。**これは想定どおり**（番号順に進める指示）。
P5-12 が来たら `POST /billing-periods/:id/agree` を足すこと。

### P5-07 が置いたもの（P5-08 が真似る）
- `lib/billing/issue.ts` — §4.1 の ①〜⑦。**ロックが採番より先。**
  明細の組み立ては採番よりさらに前（失敗しても番号を消費しない）。
- `createInvoice()` — ③〜⑥ を `db.batch()` で 1 トランザクション。
  採番の控え（`document_sequence`）も同じ束に入れる。
- `consumers/notification.ts` — ⑩〜⑫。Resend へ送り、送付ログを残し、
  `CONFIRMED` のときだけ `SENT` へ。**領収書も同じキューに載せる**
  （`kind` を足して分岐する。`isInvoiceDeliveryMessage()` の隣）。
- `lib/billing/deliver.ts` — 宛先は**スナップショットから**取る。
  マスタを引き直さない（発行後に請求先を変えても宛先が変わらない）。
- 二重発行は締めの行が防ぐ。領収書は締めに紐づかないので、
  **P5-08 は別の鍵が要る**（`receipt.invoiceId` + `paymentId`？
  §4.2 の入金記録から起こすので、そこを一意にするのが素直）。

### P5-11 に着手するときの注意
- 電帳法の検索 3 項目（取引年月日・取引金額・取引先）は
  **API 側が既にある**（`GET /invoices`・`GET /receipts` の
  `from` / `to` / `minAmount` / `maxAmount` / `counterpartyId`）。
  P5-11 は**画面**と、必要なら一覧の絞り込みの追加。
- `GET /invoices/:id/download` も実装済み（15 分の署名付き URL）。
  **`VOIDED` を弾かない**（§5.2 MUST）。
- 送付ログの画面は `GET /api/v1/deliveries?docType=&documentId=` と
  `GET /api/v1/deliveries/failed`（不達の警告）。

### ⚠ 人間の作業が 1 つ増えた（P5-10）
**実機で 1 通送って Resend の webhook payload を確かめること**
（OPEN_QUESTIONS #077）。送付ログの ID をタグとヘッダの両方に載せて
いるが、Resend が実際にどちらを返すか未確認。返らなければ bounce を
送付ログへ写せない（イベントは 200 で受けるが行が更新されない）。
併せて `RESEND_WEBHOOK_SECRET` の設定が要る（`wrangler secret put`）。

### P5-09 が置いたもの
- `correctInvoice()` — 取消 → 赤伝 → 締めの差し戻し → PDF・送付。
  **取消が先。** 取れなければ番号を消費しない。
- `REOPEN`（`INVOICED → REVIEWING`）を状態機械に追加（DECISIONS #126）。
  訂正のあと `issue-and-send` をもう一度叩けば再発行になる。
- `GET /invoices/:id/download` — 15 分の署名付き URL。
  **`VOIDED` を弾かない**（§5.2 MUST）。
- 監査 `document.corrected` は**理由必須**。

### P5-08 が置いたもの
- `renderReceiptPdf()` / `consumers` の `RECEIPT_PDF` と `RECEIPT_DELIVERY`。
  **キューは請求書と同じ**（`kind` で分ける）。
- `issueReceipt()` — 入金の記録（`PAID`）→ 採番 → INSERT。
  **一部入金は 409**（OPEN_QUESTIONS #076）。
- **`POST /api/v1/payments`（§9）は作っていない。** 入金だけを置く表が
  無いため。P5-09 か P5-11 で `payment` 表ごと判断すること。

### 未解決の問い（新しい順）
- #077 Resend の webhook がタグとヘッダのどちらを返すか未確認 → 両方送る
- #076 入金（Payment）を置く表が無い → 全額入金のみ。一部入金は 409
- #075 帳票メールの差出人が組織ごとに設定できない → `[vars]` で環境ごと 1 つ
- #074 §10.6 の「AGREED 必須の設定」に列が無い → **常に必須**（A 案）
- #073 請求書の振込先（口座情報）に対応する列が無い → 未設定なら節ごと出さない
- #072 §9 の `request-review` に対応する状態が §2.8 に無い → 状態を増やさない
- #071 取引先と施設の対応表が仕様に無い → 料金設定から導く
- #070 「再清掃の有償設定」に対応する列が無い → 計上しない
- #069 `RECHECK` に対応する品目コードが §2.4 に無い → ¥0 明細＋警告
- #068 ルール設定の画面から閾値を編集できない
- #067 W-25 の画面番号が PK-SPEC-P1 と P4 で衝突
- #066 R007 / R008 / R009 / R011 に条件の記述が無い

### P4 の積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** P5 は技術的に依存しないので
  飛ばして進めている（workflow.md §2）。

### 直近の設計判断
- #125 月次締めの cron を UTC の月末 4 日ぶんにし、判定はコードへ置く
- #124 月次締めの表に金額を持たせない
- #123 §3.2 の梯子に載らない形の料金設定を登録させない（400）
- #122 料金設定の `priority` は小さいほうが勝つ（仕様が正）
