/**
 * 請求・領収の表（PK-SPEC-P5 §2）。
 *
 * task:  docs/tasks/P5-01.md
 * 仕様: docs/PK-SPEC-P5.md §2（データモデル）/ §1（法令要件）
 * ルール: .claude/rules/billing.md §1〜§6
 *
 * ── `billing.ts` と分けてある ───────────────────────────
 * あちらは**自社が顧客から受け取る**契約（subscription / entitlement）。
 * こちらは**顧客が取引先へ出す**請求書と領収書。金額の意味も、
 * 消せるかどうかも違う。同じファイルに置くと取り違える。
 *
 * ── 発行済み帳票を消さない（CLAUDE.md §4 / billing.md §2）──
 * `invoice` / `receipt` に DELETE も UPDATE（金額・明細）も無い。
 * 訂正は**赤伝（マイナス伝票）＋再発行**（§5）。
 * `status` と送付の記録だけが後から変わる。
 * リポジトリ層が `db.delete(invoice)` を書かないことは
 * `repositories.spec.ts` がソース走査で固定する。
 *
 * ── 検索要件のための非正規化（§1.2 MUST / billing.md §2）──
 * 電子帳簿保存法は**取引年月日・取引金額・取引先**の 3 項目で検索できる
 * ことを求める。`issueDate` / `totalAmount` / `counterpartyName` を
 * 請求書と領収書の両方に持ち、索引を張る。
 * **後から足すと再構築が要る**（billing.md §2）ので最初から入れる。
 *
 * ── 金額はすべて整数（円）────────────────────────────────
 * billing.md §4。浮動小数点を使わない。**`quantity` だけが `real`**
 * （§2.4 の仕様どおり。0.5 室のような数え方がありうる）。
 * 金額の列に `real` を足さないこと。
 *
 * ── 仕様との差 ──────────────────────────────────────────
 * ① 時刻はすべて `timestamp_ms`（columns.ts の列規約 / P3-01・P4-01 と同じ）。
 * ② 一意インデックス・索引の先頭に `organizationId` を足した箇所がある。
 *    仕様の `uq_period` / `idx_pricing` / `idx_delivery` は組織をまたいで
 *    一意・検索対象になり、同居する別組織の行と衝突しうる
 *    （architecture.md §2 第1層）。P3-01・P4-01 と同じ判断。
 * ③ `invoiceLine` / `invoiceTaxSummary` は仕様に `organizationId` が
 *    無いが**足してある。** 親の `invoice` を辿らないと組織が分からない
 *    形にすると、リポジトリ層の強制注入（第1層）が掛けられない。
 */

import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { activeFlag, primaryId, tenantColumn, timestamps } from "./columns.js";
// 端数処理の語彙は組織の税務プロファイル（P0-06）が既に持っている。
// **写経しない。** 取引先ごとの既定は組織の既定を上書きするもので、
// 語彙そのものは 1 つ（billing.md §4）。
import { TAX_ROUNDING_MODES } from "./organization.js";

// ────────────────────────────────────────────────────────────
// 語彙（§2）
// ────────────────────────────────────────────────────────────

/**
 * 請求明細の品目コード（§2.4）。
 *
 * **閉じた語彙。** 増やすときは料金設定（`pricingRule.itemCode`）と
 * 集計側（P5-04）を一緒に直す。ここだけ足しても金額が付かない。
 */
export const INVOICE_ITEM_CODES = [
  "CLEAN_CHECKOUT",
  "CLEAN_STAYOVER",
  "CLEAN_DEEP",
  "CLEAN_COMMON",
  "REWORK",
  "LINEN_DAMAGE",
  "EXTRA_REQUEST",
  "LATE_CHECKOUT",
  "HOLIDAY_SURCHARGE",
  "ADJUSTMENT",
] as const;

export type InvoiceItemCode = (typeof INVOICE_ITEM_CODES)[number];

/**
 * 請求書の状態（§2.3）。
 *
 * `VOIDED` は**取り消したという状態**であって、行を消すことではない
 * （§5 / billing.md §2）。番号は欠番のまま残る（§5.3）。
 */
export const INVOICE_STATUSES = [
  "DRAFT",
  "CONFIRMED",
  "SENT",
  "VIEWED",
  "PAID",
  "PARTIALLY_PAID",
  "OVERDUE",
  "VOIDED",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** 領収書の状態（§2.6）。 */
export const RECEIPT_STATUSES = ["ISSUED", "SENT", "VOIDED"] as const;

export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** 入金方法（§2.6）。 */
export const PAYMENT_METHODS = ["BANK_TRANSFER", "CASH", "CARD", "OTHER"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * 送付する文書の種別（§2.7）。
 *
 * `DAILY_REPORT` / `AUDIT_REPORT` も含む。**送付の記録は 1 か所にまとめる**
 * （文書ごとに送付ログを作らない）。
 */
export const DELIVERY_DOC_TYPES = [
  "INVOICE",
  "RECEIPT",
  "DAILY_REPORT",
  "AUDIT_REPORT",
  /**
   * 請求明細の確認依頼（P5-17 / OPEN_QUESTIONS #078 の決着）。
   * `documentId` は `billingPeriod.id`。帳票ではないが「取引先に何を
   * いつ送ったか」の記録は同じ表に載せる（§2.7「送付の記録は 1 か所」）。
   */
  "REVIEW_REQUEST",
] as const;

export type DeliveryDocType = (typeof DELIVERY_DOC_TYPES)[number];

/** 送付経路（§2.7）。 */
export const DELIVERY_CHANNELS = ["EMAIL", "DOWNLOAD_LINK"] as const;

export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/** 送付の状態（§2.7）。`BOUNCED` は P5-10 が拾う。 */
export const DELIVERY_STATUSES = ["QUEUED", "SENT", "DELIVERED", "BOUNCED", "FAILED"] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * 月次締めの状態（§2.8）。
 *
 * `AGREED` は取引先が内容に同意した状態（§6 の合意フロー）。
 * **同意していなくても請求はできる**（§6.1）が、その事実は残る。
 */
export const BILLING_PERIOD_STATUSES = [
  "OPEN",
  "REVIEWING",
  "AGREED",
  "INVOICED",
  "CLOSED",
] as const;

export type BillingPeriodStatus = (typeof BILLING_PERIOD_STATUSES)[number];

/**
 * 双方合意フローで起きたこと（§6.1・§6.2 / P5-12）。
 *
 * **状態ではない。** `billingPeriod.status` は §2.8 の 5 つのままで、
 * ここに増えるのは**出来事**。`REQUEST_REVIEW` は状態を変えず、
 * 「ホテルへ確認を依頼した」という事実だけを残す
 * （docs/OPEN_QUESTIONS.md #072 / docs/DECISIONS.md #128）。
 */
export const BILLING_PERIOD_REVIEW_ACTIONS = ["REQUEST_REVIEW", "AGREE", "REJECT"] as const;

export type BillingPeriodReviewAction = (typeof BILLING_PERIOD_REVIEW_ACTIONS)[number];

// ────────────────────────────────────────────────────────────
// 表
// ────────────────────────────────────────────────────────────

/**
 * 取引先（§2.1）。
 *
 * **物理削除しない**（`isActive`）。過去の請求書が
 * `counterpartySnapshot` を持つので過去の帳票は壊れないが、
 * 取引先そのものは残す（PK-SPEC-P0 §24.4 と同じ方針）。
 *
 * `billingEmail` は請求書の送付先。**宿泊者の連絡先ではない**
 * （security.md §3）。取引先は法人・事業者。
 */
export const counterparty = sqliteTable(
  "counterparty",
  {
    ...primaryId,
    ...tenantColumn,
    code: text("code").notNull(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name"),
    /** 適格請求書発行事業者の登録番号（T + 13 桁 / billing.md §1）。 */
    invoiceRegistrationNo: text("invoice_registration_no"),
    postalCode: text("postal_code"),
    address1: text("address1"),
    address2: text("address2"),
    department: text("department"),
    contactName: text("contact_name"),
    billingEmail: text("billing_email").notNull(),
    ccEmails: text("cc_emails", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** 締め日（1〜31）。31 は月末の意味。 */
    closingDay: integer("closing_day").notNull().default(31),
    paymentTermDays: integer("payment_term_days").notNull().default(30),
    /** 端数処理（billing.md §4）。**取引先ごと。** */
    taxRoundingMode: text("tax_rounding_mode", { enum: TAX_ROUNDING_MODES })
      .notNull()
      .default("FLOOR"),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_cp").on(t.organizationId, t.code)],
);

/**
 * 料金設定（§2.2）。
 *
 * ── null は「すべて」──────────────────────────────────
 * `propertyId` / `roomTypeId` / `taskType` が null なら、その軸を問わない。
 * 具体的な行ほど優先される（§3.2 の 5 段階）。**解決の順序は
 * `packages/billing` の純粋関数**（P5-03 / P5-04）。ここは表だけ。
 *
 * ── 期間で持つ ──────────────────────────────────────────
 * `validFrom` / `validTo` があるので、**値上げは行の追加**で表す。
 * 既存の行を書き換えると、過去の請求書の根拠が変わる。
 */
export const pricingRule = sqliteTable(
  "pricing_rule",
  {
    ...primaryId,
    ...tenantColumn,
    counterpartyId: text("counterparty_id").notNull(),
    /** null = 取引先の全施設。 */
    propertyId: text("property_id"),
    /** null = 全客室タイプ。 */
    roomTypeId: text("room_type_id"),
    /** null = 全作業種別。 */
    taskType: text("task_type"),
    itemCode: text("item_code", { enum: INVOICE_ITEM_CODES }).notNull(),
    /** 円（税抜）。**整数**（billing.md §4）。 */
    unitPrice: integer("unit_price").notNull(),
    /** 百分率の整数（10 / 8）。 */
    taxRate: integer("tax_rate").notNull().default(10),
    isReducedRate: integer("is_reduced_rate", { mode: "boolean" }).notNull().default(false),
    validFrom: text("valid_from").notNull(),
    validTo: text("valid_to"),
    /**
     * 同じ具体度（§3.2 の同じ段）で競合したときの順位。**小さいほうが勝つ。**
     *
     * P5-01 は「大きいほうが勝つ」と書いていたが、§3.2 は
     * 「同一優先度が複数ある場合は priority の小さいものを採用」。
     * 仕様が唯一の正（CLAUDE.md §7）なので向きを直した。
     * 解決そのものは `packages/billing` の `resolvePricingRule()`。
     * docs/DECISIONS.md #122。
     */
    priority: integer("priority").notNull().default(50),
    ...timestamps,
  },
  (t) => [
    index("idx_pricing").on(t.organizationId, t.counterpartyId, t.itemCode, t.validFrom),
    index("idx_pricing_property").on(t.organizationId, t.propertyId),
  ],
);

/**
 * 請求書（§2.3）。**発行したら消せない**（billing.md §2）。
 *
 * ── 3 項目の検索索引（§1.2 MUST）──────────────────────
 * `idx_inv_search`（取引年月日 × 取引金額）と `idx_inv_party`（取引先）。
 * 電子帳簿保存法の可視性の要件そのもの。**索引を外さないこと。**
 *
 * ── スナップショット（§4.1 / billing.md §6）──────────────
 * `issuerSnapshot` / `counterpartySnapshot` は発行時に固定する。
 * **マスタを変更しても過去の帳票が変わってはならない。**
 *
 * ── 赤伝（§5）───────────────────────────────────────────
 * 訂正は `isCreditNote = true` の新しい請求書。`creditNoteForId` が
 * 対象を指す。**元の行の金額を書き換えない。**
 */
export const invoice = sqliteTable(
  "invoice",
  {
    ...primaryId,
    ...tenantColumn,
    counterpartyId: text("counterparty_id").notNull(),

    /** `INV-2026-0042`（billing.md §5）。**`DocumentSequencer` が採番する。** */
    documentNo: text("document_no").notNull(),
    revision: integer("revision").notNull().default(1),
    supersedesId: text("supersedes_id"),
    /** 赤伝の場合、対象の請求書（§5）。 */
    creditNoteForId: text("credit_note_for_id"),
    isCreditNote: integer("is_credit_note", { mode: "boolean" }).notNull().default(false),

    // ── 検索要件のための非正規化列（§1.2 MUST）──────────────
    issueDate: text("issue_date").notNull(),
    /** 税込合計。**整数（円）。** */
    totalAmount: integer("total_amount").notNull(),
    counterpartyName: text("counterparty_name").notNull(),

    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    dueDate: text("due_date").notNull(),

    subtotalAmount: integer("subtotal_amount").notNull(),
    taxAmount: integer("tax_amount").notNull(),

    /**
     * 適格請求書か（billing.md §1）。
     * **登録番号が未設定なら偽**で、PDF に「適格請求書ではありません」と出す。
     */
    isQualifiedInvoice: integer("is_qualified_invoice", { mode: "boolean" }).notNull(),
    issuerSnapshot: text("issuer_snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    counterpartySnapshot: text("counterparty_snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),

    status: text("status", { enum: INVOICE_STATUSES }).notNull().default("DRAFT"),

    pdfStorageKey: text("pdf_storage_key"),
    pdfSha256: text("pdf_sha256"),
    /** 明細を含む payload のハッシュ（§4.1 の手順⑤）。 */
    payloadSha256: text("payload_sha256"),

    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    confirmedById: text("confirmed_by_id"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    paidAt: integer("paid_at", { mode: "timestamp_ms" }),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    voidReason: text("void_reason"),

    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_inv").on(t.organizationId, t.documentNo, t.revision),
    // 電子帳簿保存法の検索要件（§1.2 MUST）。**外さないこと。**
    index("idx_inv_search").on(t.organizationId, t.issueDate, t.totalAmount),
    index("idx_inv_party").on(t.organizationId, t.counterpartyName),
    index("idx_inv_status").on(t.organizationId, t.status, t.dueDate),
    index("idx_inv_party_id").on(t.organizationId, t.counterpartyId, t.issueDate),
  ],
);

/**
 * 請求明細（§2.4）。
 *
 * **`quantity` だけが `real`。** 0.5 室のような数え方がありうる（§2.4）。
 * `unitPrice` / `amount` は整数（円）で、`amount = quantity × unitPrice` を
 * 整数演算で出す（billing.md §4）。
 *
 * `sourceRef` に集計元（タスク ID 等）を残す。**§6.3 の証跡への
 * ドリルダウン（P5-13）がここを辿る。**
 */
/**
 * 数量の単位のうち「清掃した客室の数」を表すもの。
 *
 * KPI の清掃件数（明細画面）と履歴の清掃件数（一覧）が**同じ定義で
 * 数える**ために置く。文字列を画面ごとに書くと、片方だけ直した日に
 * 一覧と明細で違う件数が出る。
 */
export const ROOM_UNIT = "室";

export const invoiceLine = sqliteTable(
  "invoice_line",
  {
    ...primaryId,
    ...tenantColumn,
    invoiceId: text("invoice_id").notNull(),
    lineNo: integer("line_no").notNull(),
    propertyId: text("property_id"),
    itemCode: text("item_code", { enum: INVOICE_ITEM_CODES }).notNull(),
    description: text("description").notNull(),
    serviceDateFrom: text("service_date_from"),
    serviceDateTo: text("service_date_to"),
    quantity: real("quantity").notNull(),
    unit: text("unit").notNull().default(ROOM_UNIT),
    unitPrice: integer("unit_price").notNull(),
    amount: integer("amount").notNull(),
    taxRate: integer("tax_rate").notNull(),
    isReducedRate: integer("is_reduced_rate", { mode: "boolean" }).notNull().default(false),
    /** 集計元（タスク ID 等）。**§6.3 のドリルダウンの手がかり。** */
    sourceRef: text("source_ref", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("uq_inv_line").on(t.organizationId, t.invoiceId, t.lineNo),
    index("idx_inv_line_invoice").on(t.organizationId, t.invoiceId),
  ],
);

/**
 * 税区分サマリー（§2.5）。
 *
 * **税率ごとに 1 行。** §2.5 MUST「消費税は税率ごとに 1 回だけ端数処理する。
 * 明細行ごとに端数処理しない」。この表が「1 回だけ」の置き場所で、
 * 明細（`invoiceLine`）に税額の列を持たせていないのはそのため。
 */
export const invoiceTaxSummary = sqliteTable(
  "invoice_tax_summary",
  {
    ...primaryId,
    ...tenantColumn,
    invoiceId: text("invoice_id").notNull(),
    taxRate: integer("tax_rate").notNull(),
    isReducedRate: integer("is_reduced_rate", { mode: "boolean" }).notNull(),
    subtotalAmount: integer("subtotal_amount").notNull(),
    taxAmount: integer("tax_amount").notNull(),
    totalAmount: integer("total_amount").notNull(),
  },
  (t) => [
    uniqueIndex("uq_tax_sum").on(t.organizationId, t.invoiceId, t.taxRate, t.isReducedRate),
  ],
);

/**
 * 領収書（§2.6）。**発行したら消せない**（billing.md §2）。
 *
 * ── 印紙貼付欄を持たない（billing.md §3）────────────────
 * PDF で発行・送付する領収書は課税文書に該当せず、**収入印紙は不要。**
 * 5 万円超でも同じ。`stampAmount` のような列を足さないこと。
 *
 * ── 請求書に紐づかない領収書がありうる ──────────────────
 * `invoiceId` は null 可（§2.6）。前受金・現金領収など。
 */
export const receipt = sqliteTable(
  "receipt",
  {
    ...primaryId,
    ...tenantColumn,
    /** null = 請求書に紐づかない領収（前受金など）。 */
    invoiceId: text("invoice_id"),
    counterpartyId: text("counterparty_id").notNull(),

    /** `RCP-2026-0018`（billing.md §5）。 */
    documentNo: text("document_no").notNull(),
    revision: integer("revision").notNull().default(1),

    // ── 検索要件のための非正規化列（§1.2 MUST）──────────────
    issueDate: text("issue_date").notNull(),
    totalAmount: integer("total_amount").notNull(),
    counterpartyName: text("counterparty_name").notNull(),

    receivedAmount: integer("received_amount").notNull(),
    receivedDate: text("received_date").notNull(),
    paymentMethod: text("payment_method", { enum: PAYMENT_METHODS }).notNull(),
    purposeText: text("purpose_text").notNull().default("清掃業務委託料として"),

    /** 税率ごとの内訳（`invoiceTaxSummary` と同じ形）。 */
    taxSummary: text("tax_summary", { mode: "json" })
      .$type<Record<string, unknown>[]>()
      .notNull(),
    isQualifiedInvoice: integer("is_qualified_invoice", { mode: "boolean" }).notNull(),
    issuerSnapshot: text("issuer_snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    counterpartySnapshot: text("counterparty_snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),

    status: text("status", { enum: RECEIPT_STATUSES }).notNull().default("ISSUED"),
    pdfStorageKey: text("pdf_storage_key"),
    pdfSha256: text("pdf_sha256"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
    voidReason: text("void_reason"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_rcp").on(t.organizationId, t.documentNo, t.revision),
    index("idx_rcp_search").on(t.organizationId, t.issueDate, t.totalAmount),
    index("idx_rcp_party").on(t.organizationId, t.counterpartyName),
    index("idx_rcp_invoice").on(t.organizationId, t.invoiceId),
  ],
);

/**
 * 送付ログ（§2.7）。
 *
 * **追記のみ。** 状態は `QUEUED → SENT → DELIVERED` と進み、
 * `BOUNCED` / `FAILED` で止まる。行を消さない（誰にいつ送ったかは
 * 電子取引の記録そのもの / billing.md §2）。
 *
 * `bodyPreview` は本文の冒頭。**差異の詳細を入れないこと**
 * （ui-writing.md §6。通知に個人情報・差異の詳細を含めない）。
 */
export const documentDelivery = sqliteTable(
  "document_delivery",
  {
    ...primaryId,
    ...tenantColumn,
    docType: text("doc_type", { enum: DELIVERY_DOC_TYPES }).notNull(),
    documentId: text("document_id").notNull(),
    channel: text("channel", { enum: DELIVERY_CHANNELS }).notNull(),
    toEmail: text("to_email").notNull(),
    ccEmails: text("cc_emails", { mode: "json" }).$type<string[]>().notNull().default([]),
    subject: text("subject").notNull(),
    bodyPreview: text("body_preview").notNull(),
    providerMessageId: text("provider_message_id"),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull(),
    errorMessage: text("error_message"),
    sentById: text("sent_by_id").notNull(),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("idx_delivery").on(t.organizationId, t.docType, t.documentId),
    index("idx_delivery_status").on(t.organizationId, t.status, t.queuedAt),
  ],
);

/**
 * 月次締め（§2.8）。
 *
 * ── ロックしてから採番する（§4.1 の手順①②）──────────────
 * `status` が `INVOICED` になったあとに集計をやり直さない。
 * **締めた期間の金額が後から動くと、送った請求書と食い違う。**
 *
 * ── 合意は事実の記録（§6）──────────────────────────────
 * `agreedByCounterparty` は取引先が同意したか。**同意していなくても
 * 請求はできる**（§6.1）が、同意なしで出したことが残る。
 */
export const billingPeriod = sqliteTable(
  "billing_period",
  {
    ...primaryId,
    ...tenantColumn,
    counterpartyId: text("counterparty_id").notNull(),
    periodFrom: text("period_from").notNull(),
    periodTo: text("period_to").notNull(),
    status: text("status", { enum: BILLING_PERIOD_STATUSES }).notNull().default("OPEN"),
    aggregatedAt: integer("aggregated_at", { mode: "timestamp_ms" }),
    agreedAt: integer("agreed_at", { mode: "timestamp_ms" }),
    agreedByCounterparty: integer("agreed_by_counterparty", { mode: "boolean" })
      .notNull()
      .default(false),
    invoiceId: text("invoice_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_period").on(t.organizationId, t.counterpartyId, t.periodFrom, t.periodTo),
    index("idx_period_status").on(t.organizationId, t.status, t.periodTo),
  ],
);

/**
 * 双方合意の履歴（§6.2 MUST / P5-12）。
 *
 * ── 仕様に無い表 ────────────────────────────────────────
 * §2 のどこにも無い。それでも足したのは、§6.2 の MUST
 * 「差戻しコメントと修正履歴をすべて保持する。『言った・言わない』を
 * 発生させない」を満たす場所が他に無いからである。`billingPeriod` は
 * 1 期間 1 行で、**差戻しは何度でも起きる。** 列を足す形では
 * 2 回目の差戻しが 1 回目を上書きする。docs/DECISIONS.md #127。
 *
 * ── 追記だけ ────────────────────────────────────────────
 * UPDATE も DELETE も無い。訂正は新しい行を足す（`evidenceSnapshot` と
 * 同じ扱い / CLAUDE.md §4）。「あとから差戻しコメントを書き換えた」が
 * できると、この表を置いた理由がそのまま消える。
 *
 * ── 明細の写しを持つ（`linesSnapshot`）────────────────────
 * 出来事のたびに、そのとき見えていた明細を JSON で固定する。
 * **金額の列は持たない**（`billingPeriod` と同じ / DECISIONS #124）。
 * 締めの明細は都度 `buildInvoiceDraft()` が出すもので、権威ではない。
 * ここに残すのは「**その時どう見えていたか**」＝ 修正履歴そのもの。
 * 合意の根拠になった数字と、いま出る数字が違えば追える。
 *
 * ── 行を指すのは `lineKey`（`lineNo` ではない）──────────
 * `@pk/billing` の `billingLineKeyOf()`（施設 × 清掃種別 × 客室タイプ）。
 * 再集計で行が増減しても、コメントが別の行へ移らない。
 */
export const billingPeriodReview = sqliteTable(
  "billing_period_review",
  {
    ...primaryId,
    ...tenantColumn,
    billingPeriodId: text("billing_period_id").notNull(),
    /** 期間の中の連番（1 から）。**履歴の順序**。時刻が同値でも並びが決まる。 */
    seq: integer("seq").notNull(),
    action: text("action", { enum: BILLING_PERIOD_REVIEW_ACTIONS }).notNull(),
    /** 期間全体へのコメント。`REJECT` は必須（§6.2 MUST）。呼び出し側が強制する。 */
    comment: text("comment"),
    /**
     * 明細行ごとのコメント（§6.2 の見本の「行2 へのコメント」）。
     *
     * `[{ lineKey, lineNo, description, comment }]`。**空配列もありうる**
     * （行を特定しない差戻し）。子表に割らないのは、1 つの出来事として
     * 読むものだからで、行単位で引きたいときは期間ぶんを読んで畳む
     * （1 期間の履歴はたかだか数十行）。
     */
    lineComments: text("line_comments", { mode: "json" })
      .$type<BillingPeriodReviewLineComment[]>()
      .notNull()
      .default([]),
    /** そのとき見えていた明細（修正履歴）。§6.2 MUST。 */
    linesSnapshot: text("lines_snapshot", { mode: "json" })
      .$type<BillingPeriodReviewLineSnapshot[]>()
      .notNull()
      .default([]),
    /** 写しの税込合計。**`billingPeriod` には書かない**（DECISIONS #124）。 */
    snapshotTotalAmount: integer("snapshot_total_amount").notNull().default(0),
    statusBefore: text("status_before", { enum: BILLING_PERIOD_STATUSES }).notNull(),
    statusAfter: text("status_after", { enum: BILLING_PERIOD_STATUSES }).notNull(),
    /**
     * 取引先（ホテル）側の意思として記録したか。
     *
     * ホテルの担当者は ProofKeeping の利用者ではない（§6.1 は
     * 「（ホテル側に通知）」までしか書かない）。**代わりに入力した人が
     * 誰かは `actorId` に残る。** `billingPeriod.agreedByCounterparty` と
     * 同じ意味で、あちらは最新の 1 件、こちらは全件。
     */
    byCounterparty: integer("by_counterparty", { mode: "boolean" }).notNull().default(false),
    /**
     * 操作した `membership.id`。**メールリンク承認（P5-17）ではシステム主体**
     * （`systemActorId()`）が入り、実際の操作者は `externalActorEmail` に残る。
     */
    actorId: text("actor_id").notNull(),
    /**
     * 組織の外の操作者（P5-17 のメールリンク承認）。
     *
     * リンクの宛先（`counterparty.billingEmail`）を記録する。ログイン主体が
     * 操作した行では null。**リンクは誰が開いたかまでは特定しない**ので、
     * これは「どの宛先に発行したリンクか」の記録である。
     */
    externalActorEmail: text("external_actor_email"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_bprv_seq").on(t.organizationId, t.billingPeriodId, t.seq),
    index("idx_bprv_period").on(t.organizationId, t.billingPeriodId),
  ],
);

/** `billingPeriodReview.lineComments` の 1 件。 */
export interface BillingPeriodReviewLineComment {
  /** `@pk/billing` の `billingLineKeyOf()`。 */
  lineKey: string;
  /** そのときの行番号（表示の再現用。**行の同定には使わない**）。 */
  lineNo: number | null;
  /** そのときの取引内容（`施設名 / 清掃種別 / 客室タイプ`）。 */
  description: string;
  comment: string;
}

/** `billingPeriodReview.linesSnapshot` の 1 行。**明細の写し。** */
export interface BillingPeriodReviewLineSnapshot {
  lineNo: number;
  lineKey: string;
  itemCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  taxRate: number;
}
