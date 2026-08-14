/**
 * 日次の施設別集計。
 *
 * task: docs/tasks/P0-21.md
 * 仕様: docs/PK-SPEC-P0.md §19.6
 *
 * ── なぜ集計テーブルが要るのか ──────────────────────────
 * テナント横断・施設横断の JOIN と集計を書かない（architecture.md §3）。
 * 施設セレクタのミニバッジ（§23.3）や全社サマリーは、**ここだけを読む。**
 * タスクテーブルへ直接集計しないこと（§26 の絶対ルール）。
 *
 * ── 更新は再計算方式 ────────────────────────────────────
 * Queue（`rollup-update`）のコンシューマがシャード内で数え直して UPSERT する。
 * **インクリメント方式にしない。** 同じメッセージが 2 回届いても結果が
 * 変わらないため（§19.6 MUST / testing.md §4）。コンシューマの実装は
 * タスクが存在するようになる P1 以降。
 *
 * ── P0 では常に 0 件 ────────────────────────────────────
 * 集計の元になる `cleaningTask` が P1 の表なので、P0 の間この表は空。
 * `/api/v1/properties/summary` は行が無ければ 0 を返す。**「まだ集計が
 * 無い」と「全部 0」を画面で区別する**ため、応答に `hasRollup` を持たせている
 * （`packages/contracts/src/property.ts`）。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn } from "./columns.js";

/**
 * 施設 × 業務日の集計。
 *
 * 列は §19.6 の定義＋**検査の 2 列**（P5-14 / DECISIONS #131）。
 * それ以外を**勝手に足さないこと。** 足すと再計算の責務がコンシューマ側で
 * 増え、冪等性の検証範囲が広がる。**金額の列は置かない**（DECISIONS #132）。
 *
 * `businessDate` は `YYYY-MM-DD`。カレンダー日ではなく施設の日締め時刻を
 * 基準にした業務日（architecture.md §7）。
 */
export const dailyPropertyRollup = sqliteTable(
  "daily_property_rollup",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    businessDate: text("business_date").notNull(),
    totalTasks: integer("total_tasks").notNull().default(0),
    completedTasks: integer("completed_tasks").notNull().default(0),
    reworkTasks: integer("rework_tasks").notNull().default(0),
    totalMinutes: integer("total_minutes").notNull().default(0),

    /**
     * その業務日に**検査の結果が確定した**タスクの数（P5-14 / DECISIONS #131）。
     *
     * 検査に回らなかったタスク（`inspectionSkipped`）を含めない。
     * §7.1 の「初回検査合格率」の**分母**で、`completedTasks` を分母にすると
     * 抽出率を上げ下げしただけで合格率が動く。
     */
    inspectedTasks: integer("inspected_tasks").notNull().default(0),

    /**
     * そのうち**1 回目の検査で合格した**タスクの数。§7.1 の分子。
     *
     * 「1 回目」は `reworkCount = 0` かつ `inspectionResult = "PASS"`。
     * 差戻しののち合格したタスクは `inspectedTasks` にだけ載る。
     */
    firstPassTasks: integer("first_pass_tasks").notNull().default(0),

    /**
     * 未解決の設備不具合の数。
     *
     * **業務日で絞っていない**（OPEN_QUESTIONS #080）。`issueReport` に
     * 業務日の列が無く、`reportedAt` から業務日を導くには施設のタイムゾーンと
     * 日締め時刻でタイムスタンプの窓を作ることになる。その手段がコード側に
     * 無いので、**再計算した時点でその施設に開いている件数**を入れる。
     * 施設セレクタのバッジ（§23.3）が読むのは当日の行なので、意味は合う。
     */
    openIssues: integer("open_issues").notNull().default(0),
    findingsHigh: integer("findings_high").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    // §19.6 の uq は (propertyId, businessDate)。**organizationId を足してある。**
    // 施設 ID は組織を含む自己記述 ID なので実質同じだが、
    // 全表で organizationId を条件に載せる（第 1 層）形と揃えておく。
    uniqueIndex("uq_rollup").on(t.organizationId, t.propertyId, t.businessDate),
    index("idx_rollup_org").on(t.organizationId, t.businessDate),
  ],
);
