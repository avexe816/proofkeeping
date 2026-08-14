# CONTINUE

## 最終状態
- main HEAD: P5-05 のマージ後
- 完了: **Phase 0〜4 と P5-01〜P5-05**（P4-08 を除く）
- 次: **P5-06（請求書 PDF テンプレート）** → **P5-07（1 クリック発行）**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P5-06.md` と `docs/tasks/P5-07.md` を読む
3. P5-06 → P5-07 は直列。**P5-07 は §4.1 の 10 手順で、①〜⑥ が
   1 トランザクション。分割して着手しない**ので、2 つで 1 バッチが素直

### P5 の依存関係
```
P5-01 ✅ → P5-02 ✅ → P5-03 ✅ → P5-04 ✅ ┬→ P5-05 ✅ → P5-12 → P5-13
                                            │              └→ P5-14 → P5-15
                                            └→ P5-06 → P5-07 ┬→ P5-08
                                                              ├→ P5-09
                                                              └→ P5-10
P5-01 → P5-11（検索・電帳法対応。独立して進められる）
```

## 申し送り

### P5-06 に着手するときの注意
- **PDF は `packages/pdf`。JSX を使わず `React.createElement` を直に呼ぶ**
  （`dailyReport.ts` の冒頭の注記。`.tsx` にすると `pk/no-literal-string` が
  帳票の固定文言に掛かる）。
- **描画は Queue コンシューマ内だけ**（§8.3 MUST / CLAUDE.md §2）。
  `renderInvoicePdf()` をリクエストハンドラから呼ばない。
- 適格請求書の 6 要件（billing.md §1 / §1.1 の表）。登録番号が未設定なら
  「適格請求書ではありません」＋ `isQualifiedInvoice = false`。
- 角印は `SEAL_IMAGE`（contracts）が既にある。
- **数値を PDF の中で再計算しない。** `dailyReport.ts` と同じで、
  payload の値をそのまま出す。金額は `buildInvoiceDraft()` が出したもの。
- 領収書 PDF（§8.2）は P5-08。**印紙貼付欄を作らない**（billing.md §3）。

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
