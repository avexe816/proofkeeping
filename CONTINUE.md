# CONTINUE

## 最終状態
- main HEAD: `f51f940` CONTINUE.md を P5-14 へ更新 (#60)
- 完了: **Phase 0〜4 と P5-01〜P5-14**（P4-08 を除く）
- 次: **P5-15（清掃会社プラン画面）で Phase 5 完走**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P5-15.md` を読む（依存 P5-14 は完了済み）
3. **下の「P5-15 は金額の出どころに気をつける」を先に読む**

### P5 の依存関係
```
P5-01 ✅ → P5-02 ✅ → P5-03 ✅ → P5-04 ✅ ┬→ P5-05 ✅ → P5-12 ✅ → P5-13 ✅
                                            │                  └→ P5-14 ✅ → P5-15 ←次
                                            └→ P5-06 ✅ → P5-07 ✅ ┬→ P5-08 ✅
                                                                    ├→ P5-09 ✅
                                                                    └→ P5-10 ✅
P5-11 ✅
```

## P5-14 が置いたもの（P5-15 はこの上に乗る）

### 集計テーブルがようやく埋まるようになった

**`daily_property_rollup` は P0-21 から存在したが、書き込む側が無く空だった。**
P5-14 が `apps/web/src/consumers/rollup.ts` を入れた。

- 投入は 3 か所。`lib/task/transition.ts`（状態が動いたあと）/
  `lib/inspection/complete.ts`（検査の確定後）/
  `consumers/reconciliation.ts`（§5.3 の手順 9。**P4-05 が飛ばしていた**）。
- **再計算方式。** 加算しない。3 回処理しても同じ（`consumers/rollup.spec.ts`）。
- `enqueueRollupUpdate()` は**例外を投げない。** 集計の失敗で現場の操作を
  止めない（DECISIONS #134）。
- 列を 2 つ足した: `inspectedTasks` / `firstPassTasks`（migration `0016`・
  追加のみ / DECISIONS #131）。

### 金額は rollup に入れていない（DECISIONS #132）

`sumInvoiceLineAmountsByProperty(env, ctx, { from, to })` が
**発行済み請求書の明細**（`CONFIRMED` / `SENT` / `PAID`）を施設別に畳む。
`DRAFT` は数えない。赤伝は含める。

**その月の請求書が無ければ `null`。0 円ではない。**

### 読み口

- `GET /api/v1/dashboard/org?month=YYYY-MM` — 全社サマリー・施設別比較・
  要対応を 1 回で返す。**全社ビューを持たないロールは 403。**
- **割合を返さない。** 分子と分母を整数で返し、画面が割る
  （`packages/contracts/src/dashboard.ts` / `lib/dashboard/format.ts`）。
- 月の範囲は `lib/baseline/dataQuality.ts` の `monthRangeOf()` を再利用。
  **同じ計算を 2 つ置かないこと。**

## ⚠ P5-15 は金額の出どころに気をつける

§7.2 の清掃会社プランは 3 つを出す。

| 欄 | 出どころ |
|---|---|
| 受託施設 12 / 清掃実績 4,128 件 | rollup（P5-14 と同じ）|
| 稼働スタッフ 34 名 | **`membership` を数える。個人の指標を出さないこと**（security.md §5）|
| 請求状況（取引先・期間・金額・状態）| `billingPeriod` / `invoice`。**取引先ごと**|
| 施設別収支（実績・請求額・実働時間・時間単価）| rollup（実績・実働時間）＋ `invoice_line`（請求額）|

**時間単価 = 請求額 ÷ 実働時間。** `totalMinutes` は分なので 60 で割る。
完了条件の「時間単価が平均の 85% 未満で警告」は**組織平均との比**で、
施設ごとの比較ではない（§7.2 MUST）。

**「未回収」は `invoice.paidAt` が無いものの合計。** 一部入金は表せない
（OPEN_QUESTIONS #076。全額入金のみ・一部入金は 409）。

金額を `formatYen()`、割合を `formatPercent()` で出す。
**`lib/dashboard/format.ts` を写経しないこと。** P5-15 が要る計算
（時間単価・85% の判定）はそこへ足す。

## 申し送り

### 人間の作業（変わらず）
1. `RESEND_WEBHOOK_SECRET` の設定（`wrangler secret put`）。
   **未設定だと webhook は 401**（素通りさせない設計）。
2. **実機で 1 通送って Resend の webhook payload を確かめる**
   （OPEN_QUESTIONS #077）。タグとヘッダのどちらが返るか未確認。
3. 和文フォントの配置（P2-14 から継続）。無いと PDF が作られない。
4. **`pk-rollup-update` キューの作成**（4 環境）。
   `wrangler queues create pk-rollup-update-{local,preview,staging}` と
   `pk-rollup-update`。宣言は `wrangler.toml` に入れてある。

### P4 の積み残し（人間待ち）
- **P4-08 誤検知率の検証（人間が実施）。** P5 は技術的に依存しない。

### 未解決の問い（新しい順）
- #082 忘れ物・設備不具合・請求期間の PC 画面が無い → 要対応の 3 行は
  件数だけでリンクを置いていない
- #081 自社清掃の組織では清掃費用合計を出せない → `null` を返す
- #080 業務日 → タイムスタンプの窓を作る手段が無い → `openIssues` は現在値
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
- #134 集計の投入は状態が動いたときに投げ、失敗を握りつぶす
- #133 rollup の `openIssues` を業務日で絞らず現在値として持つ
- #132 rollup に金額の列を置かず、清掃費用は発行済み請求書から取る
- #131 初回検査合格率のために rollup へ列を 2 つ足す
- #130 証跡は一覧に畳み込まず、`taskId` を返して W-07 へ渡す
- #129 締めの明細は発行と合意で同じ関数を通す
- #128 `request-review` は状態を増やさず出来事として履歴に残す
- #127 双方合意の履歴を新表（`billing_period_review`）で持つ
