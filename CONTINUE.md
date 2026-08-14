# CONTINUE

## 最終状態
- main HEAD: `6edeac3` P5-13 証跡へのドリルダウン (#59)
- 完了: **Phase 0〜4 と P5-01〜P5-13**（P4-08 を除く）
- 次: **P5-14（W-02 組織ダッシュボード）**

## 次にやること
1. `git fetch origin && git checkout main && git pull`
2. `docs/tasks/P5-14.md` を読む（依存 P5-05 は完了済み）
3. **下の「P5-14 は列が足りない」を先に読むこと。** 着手前に決めることがある
4. P5-14 → P5-15 で Phase 5 完走

### P5 の依存関係
```
P5-01 ✅ → P5-02 ✅ → P5-03 ✅ → P5-04 ✅ ┬→ P5-05 ✅ → P5-12 ✅ → P5-13 ✅
                                            │                  └→ P5-14 ←次 → P5-15
                                            └→ P5-06 ✅ → P5-07 ✅ ┬→ P5-08 ✅
                                                                    ├→ P5-09 ✅
                                                                    └→ P5-10 ✅
P5-11 ✅
```

## ⚠ P5-14 は列が足りない。着手前に読むこと

§7.1 の MUST は「**この画面のデータは `dailyPropertyRollup` から取得する。
タスクテーブルへの直接集計を行わない**」。ところが §7.1 の見本が並べる指標に対し、
`dailyPropertyRollup`（`packages/db/src/schema/rollup.ts`）が持つ列は 6 つしかない。

```
totalTasks / completedTasks / reworkTasks / totalMinutes / openIssues / findingsHigh
```

| §7.1 の指標 | rollup から出せるか |
|---|---|
| 清掃実績 | ✅ `totalTasks` |
| 清掃完了率 | ✅ `completedTasks / totalTasks` |
| 再清掃率 | ✅ `reworkTasks / totalTasks` |
| 平均清掃時間 | ✅ `totalMinutes / completedTasks` |
| 差異（施設別比較の右端） | ✅ `findingsHigh`（**重大のみ**。全件ではない） |
| **初回検査合格率** | ❌ **列が無い** |
| **清掃費用合計** | ❌ **列が無い**（rollup に金額を持たせていない） |
| **1室あたり原価** | ❌ 同上 |
| 施設数・客室数 | ⭕ `property` / `room` を数えるだけ（集計ではない） |

**推測で列を足さないこと**（CLAUDE.md §1-4）。次のセッションが決めるべきは:

1. **初回検査合格率** — rollup に `firstPassInspections` / `inspectedTasks` を足すか、
   指標そのものを P5-14 から落とすか。列を足すなら**再計算方式の
   コンシューマ**（`rollup-update` / architecture.md §3）も一緒に直す。
   後方互換の追加なので破壊的ではない。
2. **清掃費用合計・1室あたり原価** — 金額は取引先ごとの `billingPeriod` にあり、
   **施設ごとではない。** 料金設定（`pricingRule`）は施設を持つが、
   1 施設が複数の取引先に紐づく形を仕様が禁じていない。
   `buildPeriodDraft()` の明細は `propertyId` を持つので施設別に畳めるが、
   **それは「タスクテーブルへの直接集計」ではないものの rollup でもない。**
   MUST の読み方を決める必要がある。
3. **「要対応」の 4 件**（差異未対応 / 未解決の設備不具合 / 保管期限が近い忘れ物 /
   未締めの請求期間）は既存の口で数えられる。rollup は要らない。

決めたら `docs/OPEN_QUESTIONS.md` に起票してから実装すること。

### 画面は既にある（P0-21）

`/app/org/dashboard`（`apps/web/src/routes/app/orgDashboard.tsx`）が
**単日の施設別サマリー**を出している（PK-SPEC-P0 §23.5 / `getPropertySummaries()`）。
P5-14 の W-02 は**月次**で、全社サマリーと施設別比較と要対応が付く。
**作り直すのではなく、この画面を育てるほうが素直。**

## 申し送り

### 人間の作業（変わらず）
1. `RESEND_WEBHOOK_SECRET` の設定（`wrangler secret put`）。
   **未設定だと webhook は 401**（素通りさせない設計）。
2. **実機で 1 通送って Resend の webhook payload を確かめる**
   （OPEN_QUESTIONS #077）。タグとヘッダのどちらが返るか未確認。
3. 和文フォントの配置（P2-14 から継続）。無いと PDF が作られない。

### P5-13 が置いたもの
- `GET /billing-periods/:id/lines/tasks?lineKey=`（**発行前**。組み直す）
- `GET /invoices/:id/lines/:lineNo/tasks`（**発行後**。`sourceRef` を読む。
  **組み直さない** — 発行済みの根拠は動かない / billing.md §6）
- 証跡と写真は **P2-09 の `GET /evidence/tasks/:taskId`** をそのまま使う。
  請求専用の証跡 API を作っていない（DECISIONS #130）。
- `listTasksByIds()`（`packages/db`）。**D1 の 100 変数**で割る。
- `toTaskSummaries()` は `apps/web/src/lib/task/summary.ts`。
  タスク API と共用。**一覧の形を写経しないこと。**

### P5-12 が置いたもの
- 表 `billing_period_review`（`bprv`）。**追記だけ。** UPDATE / DELETE の
  口も関数も無い（DECISIONS #127）。
- 口は 5 本。`lines` / `request-review` / `agree` / `reject` / `reviews`。
- **差戻しは `comment` 必須**（400）。明細に無い `lineKey` も 400。
- **`request-review` は状態を変えない**（DECISIONS #128）。
- 明細の組み立ては `lib/billing/draft.ts` の `buildPeriodDraft()` に集約
  （発行も合意もここを通る / DECISIONS #129）。

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
- #130 証跡は一覧に畳み込まず、`taskId` を返して W-07 へ渡す
- #129 締めの明細は発行と合意で同じ関数を通す
- #128 `request-review` は状態を増やさず出来事として履歴に残す
- #127 双方合意の履歴を新表（`billing_period_review`）で持つ
- #126 訂正のために締めを差し戻す遷移（REOPEN）を足す
- #125 月次締めの cron を UTC の月末 4 日ぶんにし、判定はコードへ置く
