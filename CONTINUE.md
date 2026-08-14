# CONTINUE

## 最終状態
- main HEAD: P5-06 のマージ後
- 完了: **Phase 0〜4 と P5-01〜P5-06**（P4-08 を除く）
- 次: **P5-07（1 クリック発行）★中核機能**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P5-07.md` を読む（依存 P5-06 は完了済み）
3. **P5-07 は §4.1 の 10 手順で、①〜⑥ が 1 トランザクション。
   分割して着手しない。** PDF を作る側（P5-06）は既にあり、
   `QUEUE_PDF_GENERATION` へ `INVOICE_PDF` を投げれば繋がる

### P5 の依存関係
```
P5-01 ✅ → P5-02 ✅ → P5-03 ✅ → P5-04 ✅ ┬→ P5-05 ✅ → P5-12 → P5-13
                                            │              └→ P5-14 → P5-15
                                            └→ P5-06 ✅ → P5-07 ┬→ P5-08
                                                              ├→ P5-09
                                                              └→ P5-10
P5-01 → P5-11（検索・電帳法対応。独立して進められる）
```

## 申し送り

### P5-06 が置いたもの（P5-07 が繋ぐ）
- `renderInvoicePdf(payload, font, seal)` — 適格請求書の 6 要件を満たす。
  **Queue コンシューマ内でのみ呼ぶ**（§8.3 MUST）。
- `consumers/invoicePdf.ts` — `QUEUE_PDF_GENERATION` に
  `{ kind: "INVOICE_PDF", organizationId, orgShortId, invoiceId,
  sealImageKey, requestedAtMs }` を投げれば PDF が R2 に載る。
  **P5-07 がやるのは §4.1 の ⑦ でこれを投げること。**
- R2 キーは `invoices/{orgId}/{documentNo}-r{revision}.pdf`。
- `pdfSha256` の書き戻し（§4.1 の ⑧）は**コンシューマがやらない。**
  帳票の列を書き換える経路をコンシューマに持たせていないので、
  P5-07 が持つこと。
- 発行元・取引先は**スナップショットから読む。** P5-07 が
  `issuerSnapshot` に入れる項目: `legalName`（必須）/ `registrationNo`
  / `postalCode` / `address` / `tel` / `bankAccountText`（#073）。
  取引先側: `legalName`（必須）/ `postalCode` / `address1` / `address2`
  / `department` / `contactName`。

### P5-07 に着手するときの注意
- §4.1 の ①〜⑥ が 1 トランザクション、⑦以降は Queue（PDF → 送付）。
- 採番は `DocumentSequencer`（DO）経由のみ。D1 の連番を使わない。
- `Idempotency-Key` で二重発行しない（§4.3 MUST）。既に発行済みなら
  既存の請求書を返す。
- 状態遷移は `evaluateBillingPeriodTransition(status, "ISSUE_INVOICE")`。
  **`AGREED` からしか出せない。** ただし §10.6 の「双方が AGREED に
  しないと発行できない設定が可能」に当たる設定の列がまだ無い。
- 対象タスクの引き方は OPEN_QUESTIONS #071（取引先 → 施設）を見ること。

### P5-05 が置いたもの
- `@pk/billing` の `closedPeriodAsOf()` / `evaluateBillingPeriodTransition()` /
  `counterpartyPropertyScope()`。すべて純粋関数。
- `ensureBillingPeriod()` / `updateBillingPeriodStatus()`（楽観ロック付き）。
- Cron `0 19 28-31 * *`（4 本目）。JST の 1 日かは
  `isMonthlyCloseMoment()` が判定する。**式だけでは撃ち分けられない。**
- **`billing_period` に金額の列を足さないこと**（DECISIONS #124）。

### P4 の積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** これが通るまで動かせないもの:
  R007 / R008 / R009 / R011（#066）、確信度の暫定値（DECISIONS #116）、
  W-25 の閾値入力欄（#068）。
- P5 は P4-08 に技術的に依存しないので飛ばして進めている（workflow.md §2）。

### 未解決の問い（新しい順）
- #073 請求書の振込先（口座情報）に対応する列が無い → 未設定なら節ごと出さない
- #072 §9 の `request-review` に対応する状態が §2.8 に無い → 状態を増やさない
- #071 取引先と施設の対応表が仕様に無い → 料金設定から導く
- #070 「再清掃の有償設定」に対応する列が無い → `chargeRework` 既定 false
- #069 `RECHECK` に対応する品目コードが §2.4 に無い → ¥0 明細＋警告
- #068 ルール設定の画面から閾値を編集できない
- #067 W-25 の画面番号が PK-SPEC-P1 と P4 で衝突
- #066 R007 / R008 / R009 / R011 に条件の記述が無い
- #065 W-07 の「確信度の内訳」「時系列」がプロトタイプにだけある
- #064 入室記録（`roomAccessLog`）を登録する画面が仕様に無い
- #063 抑制条件が参照する施設の 2 属性に対応する列が無い

### 直近の設計判断
- #125 月次締めの cron を UTC の月末 4 日ぶんにし、判定はコードへ置く
- #124 月次締めの表に金額を持たせない
- #123 §3.2 の梯子に載らない形の料金設定を登録させない（400）
- #122 料金設定の `priority` は小さいほうが勝つ（仕様が正）
- #121 請求の 8 表に施設スコープを掛けない（`NO_PROPERTY_SCOPE` を明示）
