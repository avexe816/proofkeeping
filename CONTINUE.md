# CONTINUE

## 最終状態
- main HEAD: P5-02〜P5-04 のマージ後（PR #45）
- 完了: **Phase 0〜4 と P5-01〜P5-04**（P4-08 を除く）
- 次: **P5-05（月次締めと集計バッチ）** と **P5-06（請求書 PDF テンプレート）**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P5-05.md` と `docs/tasks/P5-06.md` を読む
3. P5-05 と P5-06 はどちらも P5-04 にだけ依存しており**並行**。
   同じバッチにまとめてよい（workflow.md §3）。そのまま P5-07 まで
   入れると 1 バッチで中核機能まで届く

### P5 の依存関係（`docs/tasks/P5-*.md` の `**依存**:` 行）
```
P5-01 ✅ → P5-02 ✅ → P5-03 ✅ → P5-04 ✅ ┬→ P5-05 → P5-12 → P5-13
                                            │           └→ P5-14 → P5-15
                                            └→ P5-06 → P5-07 ┬→ P5-08
                                                              ├→ P5-09
                                                              └→ P5-10
P5-01 → P5-11（検索・電帳法対応。独立して進められる）
```

## 申し送り

### P5-04 が置いたもの（P5-05 / P5-07 が呼ぶ）
`packages/billing` の純粋関数。**DB を引かない。** 呼び出し側が対象タスクと
料金設定を渡す。

- `buildInvoiceDraft({ tasks, pricingRules, taxRoundingMode, ... })`
  → `{ lines, taxSummaries, subtotalAmount, taxAmount, totalAmount, warnings }`
  - §3.4 の粒度（施設 × 清掃種別 × 客室タイプ）でまとめる
  - §3.1 の除外（`COMPLETED` 以外・再清掃）を**この関数の中で**行う。
    呼び出し側の WHERE 句の書き方に金額が依存しない形にしてある
  - **単価が引けないタスクは ¥0 明細＋警告。** 黙って落とさない（§3.2 MUST）
  - `sourceRef.taskIds` に集計元を全件残す（§6.3 / P5-13 のドリルダウン）
- `resolvePricingRule(rules, query)` → `{ rule, stage }` または `null`
- `summarizeTax(lines, mode)` — **端数処理は税率ごとに 1 回だけ**（§2.5 MUST）

### P5-05 に着手するときの注意
- `chargeRework` の既定は `false`（OPEN_QUESTIONS #070）。集計バッチが
  どう渡すかを決めること。取引先に列を足すなら仕様の版上げが要る
- `BillingPeriod` の状態は `OPEN→REVIEWING→AGREED→INVOICED→CLOSED`。
  **`INVOICED` になったあとに集計をやり直さない**（schema の注記）
- 冪等性（testing.md §4）— 「3 回実行しても結果が変わらない」を
  必ず検証する。`buildInvoiceDraft()` 側は並び順の反転で固定済み

### P5-06 / P5-07 に着手するときの注意
- 発行は §4.1 の 10 手順。**①〜⑥ が 1 トランザクション**で、⑦以降は
  Queue（PDF → 送付）。分割して着手しない
- PDF 生成を**リクエストハンドラで行わない**（Queue コンシューマ内のみ）
- 適格請求書の 6 要件（billing.md §1）。発行元の登録番号が未設定なら
  `isQualifiedInvoice = false` ＋「適格請求書ではありません」
- **印紙貼付欄を作らない**（billing.md §3）

### P4 の積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** これが通るまで動かせないもの:
  - R007 / R008 / R009 / R011（OPEN_QUESTIONS #066）
  - 確信度の暫定値（DECISIONS #116）
  - W-25 の閾値入力欄（OPEN_QUESTIONS #068）
- P5 は P4-08 に技術的に依存しないので飛ばして進めている
  （workflow.md §2）。

### 未解決の問い（新しい順）
- #070 「再清掃の有償設定」に対応する列が無い → `chargeRework` 既定 false
- #069 `RECHECK` に対応する品目コードが §2.4 に無い → ¥0 明細＋警告
- #068 ルール設定の画面から閾値を編集できない
- #067 W-25 の画面番号が PK-SPEC-P1 と P4 で衝突
- #066 R007 / R008 / R009 / R011 に条件の記述が無い
- #065 W-07 の「確信度の内訳」「時系列」がプロトタイプにだけある
- #064 入室記録（`roomAccessLog`）を登録する画面が仕様に無い
- #063 抑制条件が参照する施設の 2 属性に対応する列が無い

### 直近の設計判断
- #123 §3.2 の梯子に載らない形の料金設定を登録させない（400）
- #122 料金設定の `priority` は小さいほうが勝つ（仕様が正）
- #121 請求の 8 表に施設スコープを掛けない（`NO_PROPERTY_SCOPE` を明示）
- #120 請求・領収の 6 表の entityPrefix
- #119 月次監査レポートは表を持たず R2 のキーだけで管理する
