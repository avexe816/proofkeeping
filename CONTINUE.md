# CONTINUE

## 最終状態
- main HEAD: `17cea3f` P5-12 双方合意フロー (#57)
- 完了: **Phase 0〜4 と P5-01〜P5-12**（P4-08 を除く）
- 次: **P5-13（証跡へのドリルダウン）★差別化の核心**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P5-13.md` を読む（依存 P5-12 は完了済み）
3. 番号順に進める（P5-13 → P5-14 → P5-15 で Phase 5 完走）

### P5 の依存関係
```
P5-01 ✅ → P5-02 ✅ → P5-03 ✅ → P5-04 ✅ ┬→ P5-05 ✅ → P5-12 ✅ → P5-13 ←次
                                            │                  └→ P5-14 → P5-15
                                            └→ P5-06 ✅ → P5-07 ✅ ┬→ P5-08 ✅
                                                                    ├→ P5-09 ✅
                                                                    └→ P5-10 ✅
P5-11 ✅
```

## P5-13 の足場は P5-12 が置いてある

**§6.3 は「明細行 → 対象タスク一覧 → 各タスクの証跡（W-07）→ 写真」。**
このうち**明細行までは済んでいる。**

- `GET /api/v1/billing-periods/:id/lines` が明細を返す。各行に
  **`lineKey`**（`施設|清掃種別|客室タイプ` / `@pk/billing` の
  `billingLineKeyOf()`）と **`taskCount`** が付いている。
- **タスク ID の一覧は返していない。** 明細 300 行それぞれに数百件の ID を
  ぶら下げると画面を開くたびに数 MB を運ぶため、P5-13 が別の口で返す。
- 集計元は `DraftInvoiceLine.sourceRef.taskIds`（`packages/billing`）に既にある。
  発行済み請求書は `invoiceLine.sourceRef`（JSON 列）に固定されている。

### P5-13 で足すもの（案）

- **発行前**（締めの明細）: `GET /billing-periods/:id/tasks?lineKey=...`
  `lineKey` は `|` を含むので**クエリで渡す**（パスに入れると要 encode）。
  明細は `buildPeriodDraft()`（`apps/web/src/lib/billing/draft.ts`）を
  通して組み直し、`sourceRef.taskIds` を引く。**発行と同じ関数**（DECISIONS #129）。
- **発行後**（請求書の明細）: 行が不変なので `lineNo` で指してよい。
  `invoiceLine.sourceRef` に固定済みの `taskIds` を読む。**組み直さない**
  （発行時の根拠が動いてはならない）。
- 証跡そのもの（W-07）と写真は **P2-08 が置いた口をそのまま使う。**
  P5-13 で証跡 API を作り直さないこと。
- 権限: `billing.read` で入り、タスク・証跡は既存の権限で絞る。
  **`CLEANER` / `INSPECTOR` は請求から入れない**（404 / security.md §1）。

## 申し送り

### 人間の作業（変わらず）
1. `RESEND_WEBHOOK_SECRET` の設定（`wrangler secret put`）。
   **未設定だと webhook は 401**（素通りさせない設計）。
2. **実機で 1 通送って Resend の webhook payload を確かめる**
   （OPEN_QUESTIONS #077）。送付ログの ID をタグとヘッダの両方に
   載せているが、どちらが返るか未確認。
3. 和文フォントの配置（P2-14 から継続）。無いと PDF が作られない。

### P5-12 が置いたもの
- 表 `billing_period_review`（`bprv`）。**追記だけ。** UPDATE / DELETE の
  口も関数も無い（DECISIONS #127）。`updateBillingPeriodReview()` を足さないこと。
- 口は 5 本。`lines` / `request-review` / `agree` / `reject` / `reviews`。
- **差戻しは `comment` 必須**（400）。明細に無い `lineKey` も 400。
- `agree` は `REVIEWING → AGREED`、`reject` は `AGREED` からも戻れて
  **合意（`agreedAt` / `agreedByCounterparty`）を取り消す。**
- **`request-review` は状態を変えない**（DECISIONS #128 / OPEN_QUESTIONS #072 決着）。
- 明細の組み立ては `lib/billing/draft.ts` の `buildPeriodDraft()` に集約。
  発行（`issueInvoice()`）もここを通る（DECISIONS #129）。

### P4 の積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** P5 は技術的に依存しない。

### 未解決の問い（新しい順）
- #079 「AGREED 必須の設定」に列が無い → 常に必須のまま
- #078 確認依頼（§6.1 の「ホテル側に通知」）を送る経路が無い → **送っていない**
- #077 Resend の webhook がタグとヘッダのどちらを返すか未確認 → 両方送る
- #076 入金（Payment）を置く表が無い → 全額入金のみ。一部入金は 409
- #075 帳票メールの差出人が組織ごとに設定できない
- #074 §10.6 の「AGREED 必須の設定」に列が無い → 常に必須（A 案）
- #073 請求書の振込先（口座情報）に対応する列が無い
- #072 §9 の `request-review` に対応する状態が §2.8 に無い → **決着済（#128）**
- #071 取引先と施設の対応表が仕様に無い → 料金設定から導く
- #070 「再清掃の有償設定」に対応する列が無い → 計上しない
- #069 `RECHECK` に対応する品目コードが §2.4 に無い → ¥0 明細＋警告
- #068〜#063 は P4 以前（CONTINUE の履歴を参照）

### 直近の設計判断
- #129 締めの明細は発行と合意で同じ関数を通す
- #128 `request-review` は状態を増やさず出来事として履歴に残す
- #127 双方合意の履歴を新表（`billing_period_review`）で持つ
- #126 訂正のために締めを差し戻す遷移（REOPEN）を足す
- #125 月次締めの cron を UTC の月末 4 日ぶんにし、判定はコードへ置く
- #124 月次締めの表に金額を持たせない
