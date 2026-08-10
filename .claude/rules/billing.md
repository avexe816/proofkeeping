# 請求・領収ルール

請求書・領収書・金額計算を触るときは必ずこれを読む。

## 1. 適格請求書の 6 要件（MUST）

1. 発行事業者の氏名・名称と登録番号（T + 13 桁）
2. 取引年月日
3. 取引内容（軽減税率対象なら明示）
4. 税率ごとに区分した対価の合計額と適用税率
5. 税率ごとに区分した消費税額等
6. 交付を受ける事業者の氏名・名称

登録番号が未設定の場合は「適格請求書ではありません」と明記し、
`isQualifiedInvoice = false` を記録する。

## 2. 電子帳簿保存法

PDF をメール送付した時点で「電子取引」に該当する。

### 真実性の確保
ProofKeeping は「訂正・削除の履歴が残るシステム」方式を採る。
**外部タイムスタンプは導入しない。** そのため以下が必須。

- 発行済み帳票を物理削除しない（API・DB 権限の両方で禁止）
- 訂正は赤伝（マイナス伝票）＋再発行
- 元の PDF は R2 に残し、閲覧可能なまま維持する
- 全操作を `AuditLog` に記録

### 可視性の確保
取引年月日・取引金額・取引先の 3 項目で検索できること。

**そのため帳票テーブルに以下を非正規化して保持し、インデックスを張る。**
```ts
issueDate: text("issue_date").notNull(),         // YYYY-MM-DD
totalAmount: integer("total_amount").notNull(),  // 税込
counterpartyName: text("counterparty_name").notNull(),
```
これを後から追加すると再構築が必要になる。最初から入れる。

## 3. 電子領収書と印紙税

PDF で発行・送付する領収書は紙の文書の交付にあたらないため課税文書に該当せず、
**収入印紙は不要。** 5 万円超でも同様。

- 領収書テンプレートに印紙貼付欄を設けない。
- 「本領収書は電子的に発行されたため、収入印紙の貼付を要しません。」を固定表示。

## 4. 金額計算

**MUST**
- 浮動小数点を使わない。すべて整数（円）。
- 明細行の `amount = quantity × unitPrice`（整数演算）
- 税率ごとに subtotal を合計
- **税率ごとに 1 回だけ端数処理する。** 明細行ごとに端数処理しない。
- 端数処理方式は `counterparty.taxRoundingMode`（FLOOR / CEIL / ROUND）

## 5. 番号採番

```
請求書  INV-{西暦}-{連番4桁}   例: INV-2026-0042
領収書  RCP-{西暦}-{連番4桁}   例: RCP-2026-0018
日報    RPT-{西暦}-{連番4桁}
```

- 採番は `DocumentSequencer`（Durable Object）経由のみ。D1 の連番を使わない。
- 一度採番した番号は再利用しない。取消時も欠番のまま残す。
- 会計年度の切替で連番をリセットする。

## 6. スナップショット

発行時に発行元と取引先の情報を JSON で固定する。
**マスタを変更しても過去の帳票が変わってはならない。**

## 7. 発行フロー

```
① BillingPeriod をロック
② DocumentSequencer で採番
③ Invoice / InvoiceLine / InvoiceTaxSummary を INSERT
④ スナップショットを固定
⑤ payloadSha256 を計算
⑥ status = CONFIRMED
   ↑ ここまで 1 トランザクション

⑦ Queue: pdf-generation → PDF 生成 → pdfSha256 → R2
⑧ Queue: notification → Resend で送信 → DocumentDelivery 記録
⑨ status = SENT
⑩ AuditLog
```

**PDF 生成を Workers のリクエストハンドラで行わない。** Queue コンシューマ内のみ。

## 8. 料金の解決

```
1. propertyId + roomTypeId + taskType が一致
2. propertyId + taskType が一致
3. propertyId が一致
4. taskType が一致
5. 取引先の既定
```

**該当する料金設定がないタスクを黙って除外しない。**
`unitPrice = 0` の明細として計上し、画面に警告を出す。
