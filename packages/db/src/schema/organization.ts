/**
 * 組織・税務プロファイル・書類番号の永続記録。
 *
 * task: docs/tasks/P0-06.md
 * ルール: .claude/rules/billing.md §1 / §5
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { activeFlag, primaryId, tenantColumn, timestamps } from "./columns.js";

/** 端数処理方式（.claude/rules/billing.md §4）。 */
export const TAX_ROUNDING_MODES = ["FLOOR", "CEIL", "ROUND"] as const;

/** 採番する書類の種別（.claude/rules/billing.md §5）。 */
export const DOCUMENT_TYPES = ["INVOICE", "RECEIPT", "REPORT"] as const;

/**
 * 組織。
 *
 * `organizationId` は `id` と同じ値を持つ。冗長だが、
 * 「全テーブルに organizationId 列を保持する」（PK-SPEC-P0 §19.5）を
 * 例外なく成立させることを優先した。越境テストと lint が
 * テーブルごとに条件分岐せずに済む。
 *
 * `orgShortId` の**全局一意は `org_directory`（SHARD_00）が担保する。**
 * ここの unique はシャード内の第 2 防壁（docs/DECISIONS.md #014）。
 */
export const organization = sqliteTable(
  "organization",
  {
    ...primaryId,
    ...tenantColumn,
    /** ID に埋め込む 6 桁。生成は `generateOrgShortId()`。 */
    orgShortId: text("org_short_id").notNull(),
    name: text("name").notNull(),
    /** 施設側で上書きしない限りの既定タイムゾーン。 */
    timezone: text("timezone").notNull().default("Asia/Tokyo"),
    /** 管理画面の言語。ブラウザ設定は参照しない（.claude/rules/ui-writing.md §1）。 */
    locale: text("locale").notNull().default("ja"),
    /**
     * 施設選択画面（M-12）を挟む担当施設数（PK-SPEC-P1 §19.4）。
     *
     * 当日の担当施設がこの数以上なら、起動時に 1 回だけ選択画面を出す。
     * **既定 4・範囲 2〜10。** 範囲の検証は `packages/contracts` の
     * `propertySelectionThresholdSchema`（DB の既定値と二重に持たない）。
     *
     * 施設ごとではなく組織の設定にしてあるのは、この値が「1 画面に何施設
     * まで並べてよいか」という**現場端末の見やすさ**の話で、施設の属性では
     * ないため（§19.4 の閾値は組織設定と明記されている）。
     */
    propertySelectionThreshold: integer("property_selection_threshold").notNull().default(4),
    /**
     * 写真の保持期間（月）。**延長した場合だけ値が入る**（PK-SPEC-P7 §4.5）。
     *
     * `null` は「版数の既定に従う」。§4.5 MUST の「必要なら期間延長できる
     * ようにする」を受ける列で、**短くする用途には使わない**
     * （`lib/photo/retention.ts` の `resolvePhotoRetentionMonths()` が
     * 版数の既定を下限にする）。
     *
     * **`notNull` にしない。** 既定値を DB 側に持たせると、版数を上げた
     * ときに古い値が残って「上位プランなのに 6 か月で消える」が起きる。
     * 既定は版数から引く（値の出どころを 1 つにする）。
     */
    photoRetentionMonths: integer("photo_retention_months"),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_organization_short_id").on(t.orgShortId)],
);

/**
 * 適格請求書の発行元情報（.claude/rules/billing.md §1）。
 *
 * 登録番号が未設定なら適格請求書を発行できない。その判定は発行時に行い、
 * 帳票側へ `isQualifiedInvoice` として固定する（P5）。ここは現在値のマスタ。
 */
export const organizationTaxProfile = sqliteTable(
  "organization_tax_profile",
  {
    ...primaryId,
    ...tenantColumn,
    /** 登記上の名称。帳票へは発行時のスナップショットが載る（billing.md §6）。 */
    legalName: text("legal_name").notNull(),
    /** インボイス登録番号 `T` + 13 桁。未取得の間は null。 */
    invoiceRegistrationNumber: text("invoice_registration_number"),
    /** 取引先側に設定が無い場合の既定（billing.md §4）。 */
    defaultTaxRoundingMode: text("default_tax_rounding_mode", { enum: TAX_ROUNDING_MODES })
      .notNull()
      .default("ROUND"),
    postalCode: text("postal_code"),
    address: text("address"),
    tel: text("tel"),
    /** 角印画像の R2 キー（P0-16）。閲覧は署名付き URL。 */
    sealImageKey: text("seal_image_key"),
    /** 会計年度の開始月 1〜12。連番のリセット判定に使う（billing.md §5）。 */
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(4),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_tax_profile_org").on(t.organizationId)],
);

/**
 * 書類番号の永続記録。
 *
 * **採番の権威は `DocumentSequencer`（Durable Object・P0-17）。**
 * D1 の連番で採番しない（billing.md §5）。この表は DO が確定した番号を
 * 監査可能な形で残し、DO の状態が失われたときに復元の起点となる。
 */
export const documentSequence = sqliteTable(
  "document_sequence",
  {
    ...primaryId,
    ...tenantColumn,
    documentType: text("document_type", { enum: DOCUMENT_TYPES }).notNull(),
    /** 西暦。会計年度の切替で連番をリセットする（billing.md §5）。 */
    fiscalYear: integer("fiscal_year").notNull(),
    /** 直近に払い出した番号。取消しても戻さない（欠番のまま残す）。 */
    lastNumber: integer("last_number").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_document_sequence").on(t.organizationId, t.documentType, t.fiscalYear),
    index("idx_document_sequence_org").on(t.organizationId),
  ],
);
