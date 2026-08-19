# ProofKeeping 製品仕様書
## PK-SPEC-PAY — スタッフ支払集計 v1.0

> 文書ID: `PK-SPEC-PAY`
> バージョン: **v1.0**
> 発行日: 2026-08-19
> 位置づけ: PK-SPEC-P8 §1.2 の「支払集計」の正。P8 の GA 後着手原則の例外として
> オーナー指示（2026-08-19）で P5-18 として先行実装する（CLAUDE.md §9 に記録済み）。
> 前提: PK-SPEC-P5 v1.0（請求）。請求と同じタスク実績を入力とする。

---

## 0. 位置づけ

### 0.1 なぜ作るか

清掃会社は「発注元への請求」と「スタッフへの支払」を**同じ清掃実績**から起こす。
ProofKeeping は請求側（P5）だけを持ち、支払側は Excel の二重入力が残っている。
競合（YOHAKU清掃管理）は清掃報告→請求書＋給与計算の一体化を購買理由にしている。

### 0.2 何を作らないか（MUST）

- **控除計算を作らない。** 社会保険・源泉徴収・住民税・年末調整は範囲外。
  雇用スタッフ分は「支給総額の基礎」を給与ソフト向け CSV で渡す。
- **支払実行（振込）を作らない。**
- **法定の給与明細を作らない。** 出力する帳票は「支払明細書」（支給総額の内訳）。
- **個人の序列化に使わない。** 比較・ランキング・平均との対比を支払画面に出さない。
  画面に「評価には使用しません」を明記する（security.md §5）。
- 「給与計算」という語を UI に使わない。**「支払集計」**を使う。

### 0.3 用語

| 語 | 意味 |
|---|---|
| 支払集計 | 期間内のタスク実績×単価＋調整行から支給総額の基礎を出すこと |
| 支払期間 | スタッフ×月（業務日基準） |
| 調整行 | 追加対応手当・立替金など、タスク由来でない明細行 |

---

## 1. データモデル

すべて共通カラム規約（自己記述 ID・organizationId・timestamps）に従う。

### 1.1 staffPayProfile

`membership` を拡張せず別テーブル（P8-01 `staffProfile` の先行サブセット。
P8-01 実装時にこの表を包含・拡張する）。

| 列 | 型 | 説明 |
|---|---|---|
| `membershipId` | text unique | 対象スタッフ |
| `employmentType` | enum | `FULL_TIME` / `PART_TIME` / `CONTRACTOR` |
| `invoiceRegistrationNo` | text? | CONTRACTOR のみ。T+13桁 |
| `isActive` | boolean | |

**MUST**: 本籍・住所・生年月日・マイナンバー・口座情報のカラムを作らない（P8 §1.3 と同じ）。

### 1.2 payRule（単価）

`pricingRule`（請求単価）のミラー。**請求と支払の単価を同じ表に混ぜない。**

| 列 | 型 | 説明 |
|---|---|---|
| `membershipId` | text? | null = 全スタッフ既定 |
| `propertyId` | text? | null = 全施設 |
| `taskType` | text? | null = 全種別 |
| `unitType` | enum | `PER_TASK`（1件単価）/ `HOURLY`（時給） |
| `unitPrice` | integer | 円。整数のみ |
| `validFrom` / `validTo` | text? | YYYY-MM-DD |
| `priority` | integer | |

**解決順序**（billing.md §8 のミラー）:
1. membershipId + propertyId + taskType 一致
2. membershipId + taskType 一致
3. membershipId 一致
4. propertyId + taskType 一致（スタッフ指定なしの施設既定）
5. 全体既定

**該当する単価が無いタスクを黙って除外しない。** `unitPrice = 0` の明細として
計上し、画面に警告を出す（billing.md §8 と同じ原則）。

### 1.3 payoutPeriod

| 列 | 型 | 説明 |
|---|---|---|
| `membershipId` | text | |
| `periodFrom` / `periodTo` | text | YYYY-MM-DD（業務日基準） |
| `status` | enum | `OPEN` → `REVIEWING` → `CONFIRMED` |
| `aggregatedAt` / `confirmedAt` | timestamp? | |
| `documentNo` | text? | 確定時に採番（§3.2） |

一意: `(organizationId, membershipId, periodFrom, periodTo)`。

### 1.4 payoutLine

| 列 | 型 | 説明 |
|---|---|---|
| `payoutPeriodId` | text | |
| `lineNo` | integer | |
| `lineType` | enum | `TASK` / `ADJUSTMENT` / `REIMBURSEMENT` |
| `description` | text | |
| `quantity` | integer | 件数（PER_TASK）/ 分（HOURLY）/ 1（調整行） |
| `unitType` | enum? | TASK 行のみ |
| `unitPrice` | integer | 円 |
| `amount` | integer | 円。quantity × unitPrice を整数演算（HOURLY は分単価に換算せず `floor(分 × 時給 / 60)`） |
| `taskIds` | json string[] | TASK 行のみ。集計元タスク（証跡ドリルダウン。P5 §6.3 と同じ接続） |
| `reason` | text? | 調整行は必須 |
| `warning` | text? | `NO_PAY_RULE` 等 |

---

## 2. 計算規則（MUST）

- すべて整数（円）。浮動小数点を使わない。
- `PER_TASK`: 期間内に `COMPLETED` になったタスク件数 × 単価。
- `HOURLY`: `taskTimeLog` から `accumulateActualMinutes()` で得た実働分 × 時給。
  **`cleaningTask.actualMinutes` 列を根拠にしない**（キャッシュであるため）。
  端数は `floor(分 × 時給 / 60)`。**タスク行ごとに 1 回だけ端数処理する。**
- 集計は**再計算方式**（rollup と同じ）。同じ期間を 3 回集計しても結果が変わらない。
  再集計は TASK 行のみ作り直し、調整行は保持する。
- 現在時刻は `ctx.now` 注入。`packages/billing` に DB・fetch・環境変数を持ち込まない
  （計算本体は純粋関数 `packages/billing/src/payout.ts`）。
- 消費税: TASK/ADJUSTMENT 行は税計算をしない（給与・外注費の税務判断はしない）。
  CONTRACTOR の支払明細書には税区分の注記欄のみ置く。REIMBURSEMENT（立替金）は
  実費のためそのまま。

---

## 3. 業務フロー

### 3.1 状態遷移

```
OPEN →(集計実行)→ REVIEWING →(確定)→ CONFIRMED
                      ↑ 調整行の追加・再集計は REVIEWING でのみ可
```

- CONFIRMED 後の訂正は**赤伝方式**（マイナスの調整行を持つ新しい支払期間）。
  CONFIRMED の行を UPDATE / DELETE しない。
- 確定は `recordAudit`（`payout.confirmed`）。

### 3.2 帳票

- 支払明細書 PDF。採番は `DocumentSequencer` 経由 **`PAY-{西暦}-{連番4桁}`**。
  一度採番した番号は再利用しない。発行済みの削除・更新 API を作らない。
- CONTRACTOR: 仕入明細書方式を想定し、支払者・受領者の名称と登録番号欄を持つ。
- FULL_TIME / PART_TIME: 給与ソフト向け CSV（membershipId・氏名・期間・
  区分別金額・合計）。CSV は都度生成でよい（保存しない）。

---

## 4. 権限（MUST）

| 操作 | 可能なロール |
|---|---|
| `payout.read`（支払・単価の閲覧） | `OWNER` / `ORG_ADMIN` |
| `payout.write`（単価設定・集計・調整・確定） | `OWNER` / `ORG_ADMIN` |

- **`PROPERTY_MANAGER` に単価・支払を見せない**（P8 §1.3 の原則）。
- `CLIENT_VIEWER`（発注元）・`AUDITOR` も **read を含めて DENY**。
  発注元に支払（原価）を見せない。監査閲覧は請求側（billing.read）で足りる。
- スタッフ本人の閲覧（M-11 拡張）は本仕様の範囲外。需要が出たら起票する。

---

## 5. 受け入れ基準

| # | 基準 |
|---|---|
| 1 | 同じ期間を 3 回集計しても明細と合計が変わらない |
| 2 | 単価未設定のタスクが 0 円計上＋警告で表示される |
| 3 | CONFIRMED の支払期間を変更する API が存在しない |
| 4 | PROPERTY_MANAGER / CLIENT_VIEWER / AUDITOR が支払・単価に到達すると 404 |
| 5 | 支払画面に他者比較・ランキングが存在せず「評価には使用しません」が表示される |
| 6 | PAY 番号に欠番があっても再利用されない |

---

## 6. 未決事項

| # | 項目 |
|---|---|
| 1 | 立替金のモバイル入力（現場からの申請）。PC の調整行入力で開始し需要を見る |
| 2 | 支払明細書のスタッフ本人への公開（M-11 拡張）と公開時の単価表示ポリシー |
| 3 | 給与ソフト各社（ジョブカン・freee 人事労務等）の CSV 列仕様への個別対応 |

---

## 改訂履歴

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-08-19 | 初版（オーナー指示による P8 からの切り出し。P5-18） |
