# ProofKeeping 製品仕様書
## PK-SPEC-P5 — Phase 5「請求・領収・多施設」 v1.0

> 文書ID: `PK-SPEC-P5`
> バージョン: **v1.0**
> 対象期間: M8–M9
> タスク数: 15

---

ProofKeeping 製品仕様書
PK-SPEC-P5 — Phase 5「請求・領収・多施設」 v1.0
文書ID: PK-SPEC-P5
バージョン: v1.0
発行日: 2026-08-10
対象期間: M8–M9（8週間）
前提: PK-SPEC-P0 v1.1 / P1 / P2 / P3 / P4

0. 本フェーズの目的
0.1 一行目標
清掃実績から請求書と領収書を 1 クリックで発行・送付し、清掃会社とホテルが同じ数字を見て月次を締められるようにする。

Layer 1（現場を回す）と Layer 3（事実を照合する）に続く、Layer 2（お金を合わせる）の実装。清掃会社にとって最も直接的な購入理由になる。

0.2 出荷判定
月次締めから請求書 PDF 送付までが 1 クリックで完了する。

発行された請求書が適格請求書の 6 要件をすべて満たす。

領収書が入金確認から 1 クリックで発行・送付できる。

500 並列で採番しても欠番・重複が発生しない。

発行済み帳票が物理削除できない。

取引年月日・取引金額・取引先の 3 項目で検索できる。

清掃会社とホテルが同じ明細を見て相違なく合意できる。

1. 法制度上の要件
1.1 適格請求書の 6 要件（MUST）
発行するすべての請求書に以下を記載する。

#	記載事項	実装
1	発行事業者の氏名・名称と登録番号	OrganizationTaxProfile.legalName / invoiceRegistrationNo
2	取引年月日	Invoice.issueDate および明細の役務提供日
3	取引内容（軽減税率対象なら明示）	明細行の description と isReducedRate
4	税率ごとに区分した対価の合計額と適用税率	InvoiceTaxSummary
5	税率ごとに区分した消費税額等	同上
6	交付を受ける事業者の氏名・名称	Counterparty.legalName
MUST: 登録番号が未設定の組織では、請求書に「適格請求書ではありません」と明記し、isQualifiedInvoice = false を記録する。

1.2 電子取引の保存要件（MUST）
PDF をメール送付した時点で電子取引に該当する。

真実性の確保 — ProofKeeping は「訂正・削除の履歴が残るシステム」方式を採る。外部タイムスタンプは導入しない。

発行済み帳票を物理削除しない。

訂正は赤伝（マイナス伝票）＋再発行で行う。

全操作を AuditLog に記録する。

可視性の確保 — 以下を満たす。

取引年月日・取引金額・取引先で検索できる（§2.3 の非正規化列とインデックス）。

画面と書面へ速やかに出力できる。

システム概要書を docs/RUNBOOK.md に備え付ける。

1.3 電子領収書と印紙税
PDF で発行・送付する領収書は紙の文書の交付にあたらないため課税文書に該当せず、収入印紙は不要。5 万円超でも同様。

MUST:

領収書テンプレートに印紙貼付欄を設けない。

「本領収書は電子的に発行されたため、収入印紙の貼付を要しません。」を固定表示する。

印刷して紙で再交付する運用は想定しない旨を利用規約に明記する。

2. データモデル
2.1 取引先
ts
export const counterparty = sqliteTable("counterparty", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  code: text("code").notNull(),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name"),
  invoiceRegistrationNo: text("invoice_registration_no"),
  postalCode: text("postal_code"),
  address1: text("address1"),
  address2: text("address2"),
  department: text("department"),
  contactName: text("contact_name"),
  billingEmail: text("billing_email").notNull(),
  ccEmails: text("cc_emails", { mode: "json" }).$type<string[]>().notNull().default([]),
  closingDay: integer("closing_day").notNull().default(31),
  paymentTermDays: integer("payment_term_days").notNull().default(30),
  taxRoundingMode: text("tax_rounding_mode").notNull().default("FLOOR"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_cp").on(t.organizationId, t.code),
}));
2.2 料金設定
ts
export const pricingRule = sqliteTable("pricing_rule", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  counterpartyId: text("counterparty_id").notNull(),
  propertyId: text("property_id"),           // null = 取引先の全施設
  roomTypeId: text("room_type_id"),          // null = 全客室タイプ
  taskType: text("task_type"),               // null = 全種別
  itemCode: text("item_code").notNull(),     // §2.4
  unitPrice: integer("unit_price").notNull(),// 円（税抜）
  taxRate: integer("tax_rate").notNull().default(10),
  isReducedRate: integer("is_reduced_rate", { mode: "boolean" }).notNull().default(false),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  priority: integer("priority").notNull().default(50),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  idx: index("idx_pricing").on(t.counterpartyId, t.itemCode, t.validFrom),
}));
2.3 請求書
ts
export const invoice = sqliteTable("invoice", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  counterpartyId: text("counterparty_id").notNull(),

  documentNo: text("document_no").notNull(),   // INV-2026-0042
  revision: integer("revision").notNull().default(1),
  supersedesId: text("supersedes_id"),
  creditNoteForId: text("credit_note_for_id"), // 赤伝の場合、対象請求書
  isCreditNote: integer("is_credit_note", { mode: "boolean" }).notNull().default(false),

  // 検索要件のための非正規化列（MUST）
  issueDate: text("issue_date").notNull(),           // YYYY-MM-DD
  totalAmount: integer("total_amount").notNull(),    // 税込合計
  counterpartyName: text("counterparty_name").notNull(),

  periodFrom: text("period_from").notNull(),
  periodTo: text("period_to").notNull(),
  dueDate: text("due_date").notNull(),

  subtotalAmount: integer("subtotal_amount").notNull(),
  taxAmount: integer("tax_amount").notNull(),

  isQualifiedInvoice: integer("is_qualified_invoice", { mode: "boolean" }).notNull(),
  issuerSnapshot: text("issuer_snapshot", { mode: "json" }).notNull(),
  counterpartySnapshot: text("counterparty_snapshot", { mode: "json" }).notNull(),

  status: text("status").notNull().default("DRAFT"),
  // DRAFT | CONFIRMED | SENT | VIEWED | PAID | PARTIALLY_PAID | OVERDUE | VOIDED

  pdfStorageKey: text("pdf_storage_key"),
  pdfSha256: text("pdf_sha256"),
  payloadSha256: text("payload_sha256"),

  confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
  confirmedById: text("confirmed_by_id"),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  paidAt: integer("paid_at", { mode: "timestamp" }),
  voidedAt: integer("voided_at", { mode: "timestamp" }),
  voidReason: text("void_reason"),

  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_inv").on(t.organizationId, t.documentNo, t.revision),
  // 電子帳簿保存法の検索要件（MUST）
  idxSearch: index("idx_inv_search").on(t.organizationId, t.issueDate, t.totalAmount),
  idxParty: index("idx_inv_party").on(t.organizationId, t.counterpartyName),
  idxStatus: index("idx_inv_status").on(t.organizationId, t.status, t.dueDate),
}));
2.4 請求明細
ts
export const invoiceLine = sqliteTable("invoice_line", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull(),
  lineNo: integer("line_no").notNull(),
  propertyId: text("property_id"),
  itemCode: text("item_code").notNull(),
  description: text("description").notNull(),
  serviceDateFrom: text("service_date_from"),
  serviceDateTo: text("service_date_to"),
  quantity: real("quantity").notNull(),
  unit: text("unit").notNull().default("室"),
  unitPrice: integer("unit_price").notNull(),
  amount: integer("amount").notNull(),
  taxRate: integer("tax_rate").notNull(),
  isReducedRate: integer("is_reduced_rate", { mode: "boolean" }).notNull().default(false),
  sourceRef: text("source_ref", { mode: "json" }),  // 集計元のタスクID等
}, (t) => ({
  uq: uniqueIndex("uq_inv_line").on(t.invoiceId, t.lineNo),
}));
品目コード:

text
CLEAN_CHECKOUT     アウト清掃
CLEAN_STAYOVER     滞在清掃
CLEAN_DEEP         特別清掃
CLEAN_COMMON       共用部清掃
REWORK             再清掃（有償の場合）
LINEN_DAMAGE       リネン破損弁償
EXTRA_REQUEST      追加依頼作業
LATE_CHECKOUT      レイトチェックアウト対応
HOLIDAY_SURCHARGE  繁忙期割増
ADJUSTMENT         調整
2.5 税区分サマリー
ts
export const invoiceTaxSummary = sqliteTable("invoice_tax_summary", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull(),
  taxRate: integer("tax_rate").notNull(),
  isReducedRate: integer("is_reduced_rate", { mode: "boolean" }).notNull(),
  subtotalAmount: integer("subtotal_amount").notNull(),
  taxAmount: integer("tax_amount").notNull(),
  totalAmount: integer("total_amount").notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_tax_sum").on(t.invoiceId, t.taxRate, t.isReducedRate),
}));
MUST: 消費税は税率ごとに 1 回だけ端数処理する。明細行ごとに端数処理しない。

2.6 領収書
ts
export const receipt = sqliteTable("receipt", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  invoiceId: text("invoice_id"),
  counterpartyId: text("counterparty_id").notNull(),

  documentNo: text("document_no").notNull(),   // RCP-2026-0018
  revision: integer("revision").notNull().default(1),

  issueDate: text("issue_date").notNull(),
  totalAmount: integer("total_amount").notNull(),
  counterpartyName: text("counterparty_name").notNull(),

  receivedAmount: integer("received_amount").notNull(),
  receivedDate: text("received_date").notNull(),
  paymentMethod: text("payment_method").notNull(),  // BANK_TRANSFER | CASH | CARD | OTHER
  purposeText: text("purpose_text").notNull().default("清掃業務委託料として"),

  taxSummary: text("tax_summary", { mode: "json" }).notNull(),
  isQualifiedInvoice: integer("is_qualified_invoice", { mode: "boolean" }).notNull(),
  issuerSnapshot: text("issuer_snapshot", { mode: "json" }).notNull(),
  counterpartySnapshot: text("counterparty_snapshot", { mode: "json" }).notNull(),

  status: text("status").notNull().default("ISSUED"),  // ISSUED | SENT | VOIDED
  pdfStorageKey: text("pdf_storage_key"),
  pdfSha256: text("pdf_sha256"),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  voidedAt: integer("voided_at", { mode: "timestamp" }),
  voidReason: text("void_reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_rcp").on(t.organizationId, t.documentNo, t.revision),
  idxSearch: index("idx_rcp_search").on(t.organizationId, t.issueDate, t.totalAmount),
  idxParty: index("idx_rcp_party").on(t.organizationId, t.counterpartyName),
}));
2.7 送付ログ
ts
export const documentDelivery = sqliteTable("document_delivery", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  docType: text("doc_type").notNull(),      // INVOICE | RECEIPT | DAILY_REPORT | AUDIT_REPORT
  documentId: text("document_id").notNull(),
  channel: text("channel").notNull(),       // EMAIL | DOWNLOAD_LINK
  toEmail: text("to_email").notNull(),
  ccEmails: text("cc_emails", { mode: "json" }).$type<string[]>().notNull().default([]),
  subject: text("subject").notNull(),
  bodyPreview: text("body_preview").notNull(),
  providerMessageId: text("provider_message_id"),
  status: text("status").notNull(),         // QUEUED | SENT | DELIVERED | BOUNCED | FAILED
  errorMessage: text("error_message"),
  sentById: text("sent_by_id").notNull(),
  queuedAt: integer("queued_at", { mode: "timestamp" }).notNull(),
  sentAt: integer("sent_at", { mode: "timestamp" }),
  deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  openedAt: integer("opened_at", { mode: "timestamp" }),
}, (t) => ({
  idx: index("idx_delivery").on(t.docType, t.documentId),
}));
2.8 月次締め
ts
export const billingPeriod = sqliteTable("billing_period", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  counterpartyId: text("counterparty_id").notNull(),
  periodFrom: text("period_from").notNull(),
  periodTo: text("period_to").notNull(),
  status: text("status").notNull().default("OPEN"),
  // OPEN | REVIEWING | AGREED | INVOICED | CLOSED
  aggregatedAt: integer("aggregated_at", { mode: "timestamp" }),
  agreedAt: integer("agreed_at", { mode: "timestamp" }),
  agreedByCounterparty: integer("agreed_by_counterparty", { mode: "boolean" })
    .notNull().default(false),
  invoiceId: text("invoice_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (t) => ({
  uq: uniqueIndex("uq_period").on(t.counterpartyId, t.periodFrom, t.periodTo),
}));
3. 集計と料金計算
3.1 集計対象
text
対象: 期間内に status = COMPLETED となった CleaningTask
除外:
  - CANCELLED
  - BLOCKED のまま終了
  - 再清掃（ReworkCycle）※ 有償設定の場合のみ計上
3.2 料金の決定
pricingRule を以下の優先順で解決する。

text
1. propertyId + roomTypeId + taskType が一致
2. propertyId + taskType が一致
3. propertyId が一致
4. taskType が一致
5. 取引先の既定

同一優先度が複数ある場合は priority の小さいものを採用。
validFrom / validTo で有効期間を判定する。
MUST: 該当する料金設定がないタスクは請求から除外せず、unitPrice = 0 の明細として計上し、画面に警告を出す。黙って落とさない。

3.3 端数処理
text
1. 明細行の amount = quantity × unitPrice（整数演算のみ）
2. 税率ごとに subtotal を合計
3. 税率ごとに tax = subtotal × rate / 100 を計算し、1 回だけ端数処理
4. 端数処理方式は counterparty.taxRoundingMode に従う
MUST: 浮動小数点で金額を扱わない。すべて整数（円）で計算する。

3.4 明細の粒度
text
既定: 施設 × 清掃種別 × 客室タイプ でまとめる

例:
  サンプルホテル東京 / アウト清掃 / シングル   180室 × ¥3,200 = ¥576,000
  サンプルホテル東京 / アウト清掃 / ツイン      95室 × ¥3,800 = ¥361,000
  サンプルホテル東京 / 滞在清掃                 42室 × ¥1,800 =  ¥75,600
取引先ごとに「客室単位の明細を添付する」設定が可能。その場合は PDF の別紙として全タスク一覧を添付する。

4. 1 クリック発行フロー
4.1 請求書
text
W-30 月次締め画面
  サンプル清掃 → サンプルホテル東京
  2026年9月分  清掃 317件  ¥1,012,600（税込 ¥1,113,860）

              [ 明細を確認 ]  [ 請求書を発行して送信 ]
                                        │
                                        v
  ┌─── 確認ダイアログ ──────────────────────┐
  │ 請求書を発行して送信します                │
  │                                          │
  │ 宛先: サンプルホテル運営株式会社          │
  │       keiri@example.co.jp                │
  │ CC:   manager@example.co.jp              │
  │ 金額: ¥1,113,860（税込）                 │
  │ 期日: 2026年10月31日                     │
  │                                          │
  │ 発行後は編集できません。                  │
  │ 訂正が必要な場合は赤伝処理となります。     │
  │                                          │
  │           [ キャンセル ] [ 発行して送信 ] │
  └──────────────────────────────────────────┘
                                        │
                                        v
  1 トランザクションで実行
    ① BillingPeriod を INVOICED にロック
    ② DocumentSequencer（DO）で番号採番
    ③ Invoice / InvoiceLine / InvoiceTaxSummary を INSERT
    ④ issuerSnapshot / counterpartySnapshot を固定
    ⑤ payloadSha256 を計算
    ⑥ status = CONFIRMED
                                        │
                                        v
  Queue: pdf-generation
    ⑦ PDF 生成
    ⑧ pdfSha256 を計算
    ⑨ R2 へ保存
                                        │
                                        v
  Queue: notification
    ⑩ Resend でメール送信
    ⑪ DocumentDelivery を記録
    ⑫ status = SENT
    ⑬ AuditLog に記録
MUST: ③〜⑥ は同一トランザクション。PDF 生成やメール送信の失敗で請求書レコードが消えてはならない。PDF 未生成の状態は CONFIRMED として表現し、再生成できるようにする。

4.2 領収書
text
W-31 入金管理画面
  INV-2026-0042  ¥1,113,860  期日 10/31

              [ 入金を記録 ]
                    │
                    v
  入金日 [ 2026/10/28 ]  金額 [ 1,113,860 ]
  方法   [ 銀行振込 ▾ ]
  [ ] 領収書を発行して送信する          ← 既定でチェック
                    │
                    v
  ① Payment を記録、Invoice を PAID に
  ② DocumentSequencer で RCP 番号採番
  ③ Receipt を INSERT
  ④ PDF 生成 → R2
  ⑤ メール送信
  ⑥ AuditLog
4.3 冪等性
MUST: 「発行して送信」ボタンは Idempotency-Key を付与する。連打・再送で 2 通目が発行されない。既に発行済みの場合は既存の請求書を返す。

5. 訂正処理
5.1 原則
発行済み帳票は削除も編集もしない。訂正は赤伝＋再発行で行う。

text
INV-2026-0042  ¥1,113,860        （元）
INV-2026-0051  ¥-1,113,860       （赤伝 / creditNoteForId = 0042）
INV-2026-0052  ¥1,098,240        （再発行）
5.2 手順
text
1. 元請求書の [ 訂正する ] を押す
2. 訂正理由を入力（必須）
3. 赤伝が自動生成され、元請求書が VOIDED になる
4. 新しい請求書の編集画面が開く（元の明細をコピー）
5. 修正して発行
6. 赤伝と再発行分の 2 通を同時にメール送付
MUST: 元の PDF は R2 に残し、閲覧できる状態を維持する。ダウンロードリンクを無効化しない。

5.3 番号の欠番
採番済みの番号は再利用しない。取消時も欠番のまま残す。

6. 双方合意フロー
清掃会社とホテルが同じ数字で締められるようにする。

6.1 状態遷移
text
OPEN
  │ 月次集計バッチ（毎月 1 日 04:00）
  v
REVIEWING          清掃会社が明細を確認・修正
  │ 清掃会社が「ホテルへ確認依頼」
  v
（ホテル側に通知）
  │ ホテルが明細を確認
  ├ 承認 → AGREED
  └ 差戻し → REVIEWING（コメント付き）
  │
  v
AGREED
  │ 清掃会社が請求書を発行
  v
INVOICED
  │ 入金確認
  v
CLOSED
6.2 差戻し
ホテル側は明細行単位でコメントを付けて差し戻せる。

text
サンプルホテル東京 2026年9月分

行  内容                        数量   金額        確認
1   アウト清掃 / シングル        180  ¥576,000    ○
2   アウト清掃 / ツイン           95  ¥361,000    △ ← コメント
3   滞在清掃                      42   ¥75,600    ○

行2 へのコメント（ホテル側）
「9/15 の 3 室は当方都合でキャンセルしています。ご確認ください。」
MUST: 差戻しコメントと修正履歴をすべて保持する。「言った・言わない」を発生させない。

6.3 証跡との接続
明細行から集計元のタスクへドリルダウンできる。

text
行2 アウト清掃 / ツイン 95室
  → 対象タスク一覧（95件）
    → 各タスクの証跡（P2 の W-07）
      → 清掃時刻・検査結果・写真
これが ProofKeeping の請求機能が他社と決定的に異なる点。請求根拠が写真とタイムスタンプまで遡れる。

7. 多施設ダッシュボード
7.1 W-02 組織ダッシュボード
text
サンプル運営株式会社          2026年9月

━━━ 全社サマリー ━━━━━━━━━━━━━━━━━━━━

施設数 3 ・ 客室数 120 ・ 清掃実績 2,847件

清掃完了率      98.2%
初回検査合格率  91.4%
再清掃率         8.6%
平均清掃時間    28.3分
清掃費用合計    ¥8,241,600
1室あたり原価   ¥2,894

━━━ 施設別比較 ━━━━━━━━━━━━━━━━━━━━

施設          実績   完了率  合格率  平均時間  1室原価  差異
ホテル東京    1,412  99.1%   93.2%   26.8分   ¥2,780    3件
イン大阪        982  97.8%   89.1%   29.1分   ¥2,950    7件
旅館京都        453  96.9%   90.7%   32.4分   ¥3,120    2件

━━━ 要対応 ━━━━━━━━━━━━━━━━━━━━━━

差異レポート 未対応     2件  [ 確認する ]
未解決の設備不具合      5件  [ 確認する ]
保管期限が近い忘れ物    3件  [ 確認する ]
未締めの請求期間        1件  [ 確認する ]
MUST: この画面のデータは dailyPropertyRollup（P0 v1.1 §19.6）から取得する。タスクテーブルへの直接集計を行わない。

7.2 清掃会社プラン
清掃会社（OrgType = VENDOR）向けの画面。

text
サンプル清掃株式会社          2026年9月

受託施設 12 ・ 稼働スタッフ 34名 ・ 清掃実績 4,128件

━━━ 請求状況 ━━━━━━━━━━━━━━━━━━━━━━

取引先              期間      金額         状態
ホテルA運営      2026/09  ¥1,113,860   入金済
ホテルB運営      2026/09    ¥842,300   送付済
ホテルC運営      2026/09    ¥398,100   合意待ち  ← 要対応
ホテルD運営      2026/09    ¥521,400   集計中

売上合計 ¥2,875,660 ・ 未回収 ¥1,761,800

━━━ 施設別収支 ━━━━━━━━━━━━━━━━━━━━

施設        実績   請求額      実働時間   時間単価
ホテルA    1,412  ¥1,113,860    631h      ¥1,765
ホテルB      982    ¥842,300    478h      ¥1,762
ホテルC      453    ¥398,100    245h      ¥1,625  ← 低い
MUST: 時間単価が組織平均の 85% を下回る施設に警告を出す。清掃会社にとって「赤字案件の早期発見」が最大の価値になる。

8. PDF テンプレート
8.1 請求書
text
                                          請求書
                                          INV-2026-0042
                                          発行日 2026年10月1日

サンプルホテル運営株式会社 御中
〒100-0001 東京都千代田区...

下記のとおりご請求申し上げます。

  ご請求金額  ¥1,113,860 -
  お支払期限  2026年10月31日

                            サンプル清掃株式会社
                            登録番号 T1234567890123
                            〒150-0001 東京都渋谷区...
                            TEL 03-xxxx-xxxx        [角印]

対象期間: 2026年9月1日 〜 9月30日

No 内容                          数量  単位  単価      金額      税
 1 アウト清掃 / シングル          180   室  ¥3,200  ¥576,000  10%
 2 アウト清掃 / ツイン             95   室  ¥3,800  ¥361,000  10%
 3 滞在清掃                        42   室  ¥1,800   ¥75,600  10%
                                          小計    ¥1,012,600

  10% 対象  ¥1,012,600   消費税 ¥101,260
                              合計 ¥1,113,860

お振込先
  サンプル銀行 渋谷支店 普通 1234567
  サンプルセイソウ(カ

備考
  明細は別紙のとおりです。
8.2 領収書
text
                                          領収書
                                          RCP-2026-0018
                                          発行日 2026年10月28日

サンプルホテル運営株式会社 様

  ¥1,113,860 -

  但し 清掃業務委託料として（2026年9月分）
  上記正に領収いたしました。

  内訳
    10% 対象      ¥1,012,600
    消費税          ¥101,260

  お支払方法  銀行振込
  入金日      2026年10月28日
  対象請求書  INV-2026-0042

                            サンプル清掃株式会社
                            登録番号 T1234567890123
                            〒150-0001 東京都渋谷区...
                                                    [角印]

本領収書は電子的に発行されたため、収入印紙の貼付を要しません。
8.3 生成
MUST: PDF 生成は Queue コンシューマ内で実行する。Workers のリクエストハンドラで生成しない（CPU 時間の制約）。

9. API
text
GET    /api/v1/counterparties
POST   /api/v1/counterparties
PATCH  /api/v1/counterparties/:id

GET    /api/v1/pricing-rules?counterpartyId=
POST   /api/v1/pricing-rules
PATCH  /api/v1/pricing-rules/:id

GET    /api/v1/billing-periods?counterpartyId=&status=
POST   /api/v1/billing-periods/:id/aggregate
POST   /api/v1/billing-periods/:id/request-review
POST   /api/v1/billing-periods/:id/agree
POST   /api/v1/billing-periods/:id/reject

GET    /api/v1/invoices?from=&to=&minAmount=&maxAmount=&counterparty=
GET    /api/v1/invoices/:id
POST   /api/v1/invoices/issue-and-send      ★1クリック
POST   /api/v1/invoices/:id/regenerate-pdf
POST   /api/v1/invoices/:id/resend
POST   /api/v1/invoices/:id/void
POST   /api/v1/invoices/:id/credit-note
GET    /api/v1/invoices/:id/download

GET    /api/v1/receipts?from=&to=&minAmount=&maxAmount=&counterparty=
POST   /api/v1/receipts/issue-and-send      ★1クリック
GET    /api/v1/receipts/:id/download

POST   /api/v1/payments
GET    /api/v1/deliveries?docType=&documentId=
MUST: 検索 API は取引年月日・取引金額・取引先の 3 条件を組み合わせて指定できる。電子帳簿保存法の検索要件を満たすため。

10. 受け入れ基準
10.1 適格請求書
6 要件がすべて PDF に記載される

登録番号未設定時に「適格請求書ではありません」が表示される

税率ごとに区分された消費税額が表示される

端数処理が税率ごとに 1 回だけ行われる

金額計算に浮動小数点が使われていない

10.2 電子帳簿保存法
発行済み帳票を UI・API から削除できない

訂正が赤伝＋再発行で行われる

元 PDF が閲覧可能なまま維持される

取引年月日・金額・取引先の 3 条件で検索できる

全操作が AuditLog に記録される

10.3 領収書
印紙貼付欄がない

電子発行の注記が固定表示される

入金記録から 1 クリックで発行・送付できる

10.4 採番
500 並列で欠番・重複が発生しない

取消時に番号が欠番のまま残る

年度切替で連番がリセットされる

10.5 1 クリック
締め画面から送付完了まで 1 クリック＋確認 1 回

Idempotency-Key で二重発行されない

PDF 生成失敗時も請求書レコードが残る

再生成・再送ができる

10.6 合意フロー
明細行単位で差戻しコメントが付けられる

修正履歴がすべて残る

明細から集計元タスクの証跡へドリルダウンできる

双方が AGREED にしないと請求書を発行できない設定が可能

10.7 ダッシュボード
rollup テーブルから取得している（タスク直接集計でない）

施設横断の JOIN を発行していない

時間単価が平均の 85% 未満で警告が出る

11. リスクと対策
リスク	影響	対策
料金設定の抜けで請求漏れ	売上損失	単価未設定を ¥0 明細＋警告で可視化
端数処理の相違で 1 円ズレ	経理からのクレーム	税率ごと 1 回、整数演算を徹底
誤った請求書を送ってしまう	信用問題	確認ダイアログ、赤伝フロー、送付ログ
メール不達に気づかない	入金遅延	Resend の bounce webhook を受け、画面で警告
発行済みデータを消してしまう	法令違反	物理削除の API を作らない。DB 権限でも禁止
双方合意が形骸化	争いの再発	差戻しコメント必須、証跡ドリルダウン
12. 改訂履歴
バージョン	日付	変更内容
v1.0	2026-08-10	初版確定
13. 未決事項
請求書の別紙（客室単位の全明細）を既定で添付するか、要望時のみか。

入金消込を銀行 API と連携するか、手動記録のみとするか。

複数施設を 1 通の請求書にまとめるか、施設ごとに分けるか。取引先設定で選択させる案。

ホテル側が ProofKeeping を使っていない場合、合意フローをどう成立させるか。メールリンクでの簡易承認を検討。

消費税の端数処理を取引先ごとでなく請求書ごとに変更する需要があるか。

14. Claude Code 作業指示
text
# ProofKeeping — Phase 5

## 前提
- 仕様の唯一の正は docs/PK-SPEC-P5.md（v1.0）。
- P0 v1.1 §19.9 の DocumentSequencer（Durable Object）が動作していること。
- P2 の日報が集計元として機能していること。

## 実装順序
1. §2 DB migration
2. §2.1 取引先マスタ
3. §2.2 料金設定
4. §3 集計と料金計算（純粋関数として packages/billing に）
5. §2.8 月次締めと集計バッチ
6. §4.1 請求書の 1 クリック発行
7. §8 PDF テンプレート（Queue コンシューマ）
8. §4.2 領収書
9. §5 訂正・赤伝
10. §6 双方合意フロー
11. §7 ダッシュボード

## P5 固有の絶対ルール
- 発行済み帳票の DELETE / UPDATE API を作らない。
- 金額計算に浮動小数点を使わない。すべて整数（円）。
- 端数処理は税率ごとに 1 回だけ。
- 領収書に印紙貼付欄を設けない。
- 請求書に issueDate / totalAmount / counterpartyName を非正規化して保持し、
  インデックスを張る（電子帳簿保存法の検索要件）。
- 発行時に issuerSnapshot / counterpartySnapshot を固定する。
  マスタ変更で過去の帳票が変わってはならない。
- 番号採番は DocumentSequencer（DO）経由のみ。D1 の連番を使わない。
- PDF 生成を Workers のリクエストハンドラで行わない。
- 単価未設定のタスクを黙って除外しない。¥0 明細＋警告。

## テスト必須
- 500 並列採番の欠番・重複
- 端数処理（10% / 8% 混在、3 種類の丸め）
- Idempotency-Key での二重発行防止
- 赤伝と再発行の整合性
- 3 条件検索（日付・金額・取引先）
- PDF 生成失敗時のリカバリ
- 発行済み帳票の削除が API・DB 両面で不可能
