/**
 * 日報（清掃実績日報）。
 *
 * task: docs/tasks/P2-14.md
 * 仕様: docs/PK-SPEC-P2.md §9.4
 * ルール: .claude/rules/billing.md §2（電帳法 / 発行済み帳票を消さない）
 *
 * ── 発行済みの帳票である ────────────────────────────────
 * 日報は「清掃会社が施設へ提出する」文書で、P5 の請求明細の元データになる
 * （§9.1）。**CLAUDE.md §4 の「発行済み帳票の DELETE / UPDATE API を
 * 作らない」がそのまま掛かる。** リポジトリ（`repositories/dailyReport.ts`）は
 * INSERT と SELECT しか持たない。訂正は行の書き換えではなく
 * **revision を上げた新しい行**で表す（§9.3）。
 *
 * ── revision を持つ理由 ─────────────────────────────────
 * 「再生成は同じ文書番号を上書きしない。revision = 2 として新しい PDF を
 * 生成し、旧版を保持する」（§9.3）。**文書番号は業務日ごとに 1 つで、
 * 版だけが増える。** だから `documentNo` は一意制約に含めず、
 * 一意なのは `(propertyId, businessDate, revision)` の 3 つ。
 * R2 のキーにも revision が入る（§9.5）ので、旧版の PDF も残り続ける。
 *
 * ── 集計値を列に持たせてある ────────────────────────────
 * §9.4 の定義どおり。**`payload` を読まないと件数が分からない形にしない。**
 * 一覧（§14.4 の `GET /reports/daily`）は 1 か月ぶんの行を返すので、
 * そのたびに R2 の PDF や JSON を開くことになると実用にならない。
 * 列の値と PDF の集計値が食い違わないことは、**両方を同じ payload から
 * 作る**ことで担保する（`lib/report/dailyReport.ts`）。
 *
 * ── payload そのものを DB に持たない ────────────────────
 * `payloadSha256` だけを持つ。日報の payload は明細を全部含むので
 * 100 室で数十 KB になり、D1 の行に載せると一覧クエリが重くなる。
 * **中身は PDF と `EvidenceSnapshot`（§6）の側に残る。**
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn } from "./columns.js";

/**
 * 日報（§9.4 の `DailyReport`）。
 *
 * 列は §9.4 の定義そのまま（`organizationId` は全業務表の必須列 /
 * `columns.ts`）。**`status` を足していない。** 行が入るのは PDF を R2 へ
 * 置き終えた後だけで、途中の状態を持たせると「PDF の無い日報」を
 * 一覧に出すことになる（`consumers/dailyReport.ts` の注記）。
 */
export const dailyReport = sqliteTable(
  "daily_report",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    /** 業務日 `YYYY-MM-DD`（architecture.md §7）。カレンダー日ではない。 */
    businessDate: text("business_date").notNull(),
    /** `RPT-2026-0042`（billing.md §5）。**版が変わっても同じ番号。** */
    documentNo: text("document_no").notNull(),
    revision: integer("revision").notNull().default(1),
    /** R2 のキー（§9.5）。`{documentNo}-r{revision}.pdf` で終わる。 */
    storageKey: text("storage_key").notNull(),
    /** 正規化 JSON の SHA-256（§6.2 と同じ作り方）。 */
    payloadSha256: text("payload_sha256").notNull(),
    /** PDF のバイト列の SHA-256。R2 の `customMetadata` にも同じ値を置く（§9.5）。 */
    pdfSha256: text("pdf_sha256").notNull(),
    totalTasks: integer("total_tasks").notNull().default(0),
    completedTasks: integer("completed_tasks").notNull().default(0),
    /** 初回検査で不合格になった件数（§9.2 の「差戻し」）。 */
    failedFirstInspection: integer("failed_first_inspection").notNull().default(0),
    openIssues: integer("open_issues").notNull().default(0),
    openLostItems: integer("open_lost_items").notNull().default(0),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
    /** 手動再生成した `membership.id`。**自動生成では null**（§9.3）。 */
    generatedById: text("generated_by_id"),
    /** 前の版の `dailyReport.id`。revision 1 では null。 */
    supersedesId: text("supersedes_id"),
  },
  (t) => [
    // §9.4 の uq は (propertyId, businessDate, revision)。
    // `organizationId` を足す理由は `rollup.ts` の注記と同じ。
    uniqueIndex("uq_daily_report_revision").on(
      t.organizationId,
      t.propertyId,
      t.businessDate,
      t.revision,
    ),
    index("idx_daily_report_property_date").on(t.organizationId, t.propertyId, t.businessDate),
  ],
);
