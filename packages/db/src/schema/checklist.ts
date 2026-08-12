/**
 * チェックリストの定義（テンプレート・項目）と実施結果。
 *
 * task: docs/tasks/P1-01.md / docs/tasks/P1-06.md
 * 仕様: docs/PK-SPEC-P1.md §2.1 / §6（テンプレートの階層・既定テンプレート）
 * 契約: docs/PK-IMPL-CONTRACT.md §2.4（INV-22）
 *
 * ── 実施結果を 3 値にした ───────────────────────────────
 * 仕様 §2.1 の `TaskChecklistResult` は `isChecked: Boolean` だが、
 * **INV-22 は「チェックリストは 3 値入力（○／×／該当なし）とする。
 * 2 値にしない」と定めている。** CLAUDE.md §7 は実装契約書を優先すると
 * 定めているため、契約書 §2.4 の `value`（`DONE` / `COULD_NOT` /
 * `NOT_APPLICABLE`）を採った。矛盾は docs/OPEN_QUESTIONS.md #032 に起票済み。
 *
 * 進捗の分母は `NOT_APPLICABLE` を除いた件数、分子は `DONE` の件数（同 §2.4）。
 *
 * ── templateVersion を実施結果側に持つ ──────────────────
 * 後からテンプレートを変更しても、過去の実施記録の意味が変わらないため
 * （§2.2）。P4 の証跡としての価値を守る。**この列を更新しないこと。**
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { activeFlag, primaryId, sortOrderColumn, tenantColumn, timestamps } from "./columns.js";
import { TASK_TYPES } from "./task.js";

/** 実施結果の 3 値（PK-IMPL-CONTRACT §2.4 / INV-22）。 */
export const CHECKLIST_VALUES = ["DONE", "COULD_NOT", "NOT_APPLICABLE"] as const;

export type ChecklistValue = (typeof CHECKLIST_VALUES)[number];

/**
 * チェックリストのテンプレート。
 *
 * ── 3 階層の継承（§6.1）────────────────────────────────
 * ```
 * 組織共通（propertyId = null, roomTypeId = null）
 *   ↓ 上書き
 * 施設別  （propertyId 指定, roomTypeId = null）
 *   ↓ 上書き
 * 客室タイプ別（propertyId 指定, roomTypeId 指定）
 * ```
 * タスク生成時に**最も具体的なものを 1 つ**選び、`taskChecklistResult` へ
 * 展開する。選択そのものは `packages/engine` の `resolveChecklistTemplate()`
 * が行う純粋関数（DB を引かない）。
 *
 * ── SQLite の UNIQUE と NULL ────────────────────────────
 * `propertyId` / `roomTypeId` が null の行は、SQLite の UNIQUE では
 * 重複を弾けない（NULL 同士は別値）。組織共通テンプレートの重複は
 * リポジトリ層が防ぐ（`floor` と同じ事情）。
 */
export const checklistTemplate = sqliteTable(
  "checklist_template",
  {
    ...primaryId,
    ...tenantColumn,
    /** null = 組織共通。 */
    propertyId: text("property_id"),
    /** null = 全客室タイプ。 */
    roomTypeId: text("room_type_id"),
    taskType: text("task_type", { enum: TASK_TYPES }).notNull(),
    name: text("name").notNull(),
    /**
     * 版。**項目を変えたら上げる。** 実施済みの記録は
     * `taskChecklistResult.templateVersion` で当時の版に固定される。
     */
    version: integer("version").notNull().default(1),
    ...activeFlag,
    ...timestamps,
  },
  (t) => [
    index("idx_checklist_template_scope").on(
      t.organizationId,
      t.propertyId,
      t.taskType,
      t.isActive,
    ),
  ],
);

/**
 * チェックリストの項目。
 *
 * `labels` は `{ "ja": "...", "en": "..." }`（§12.2）。**JSX に直書きしない**
 * という規約（ui-writing.md §1）の対象外で、これは業務データ。
 * 未翻訳なら日本語を表示する判断は画面側（P1-10）が行う。
 */
export const checklistItem = sqliteTable(
  "checklist_item",
  {
    ...primaryId,
    ...tenantColumn,
    templateId: text("template_id").notNull(),
    /** 「ベッドまわり」「浴室」など。セクション単位で折りたためる（§6.3）。 */
    section: text("section").notNull(),
    /** 言語コード → 表示文言。 */
    labels: text("labels", { mode: "json" }).$type<Record<string, string>>().notNull(),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    photoRequired: integer("photo_required", { mode: "boolean" }).notNull().default(false),
    ...sortOrderColumn,
    ...timestamps,
  },
  (t) => [index("idx_checklist_item_template").on(t.organizationId, t.templateId, t.sortOrder)],
);

/**
 * タスクごとの実施結果。タスク生成時にテンプレートから展開する（§6.1）。
 *
 * `checkedAt` は**項目ごとに**記録する（§6.3）。連打で全項目が同一秒に
 * なっている場合、P4 が品質の手がかりとして扱える。
 */
export const taskChecklistResult = sqliteTable(
  "task_checklist_result",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    taskId: text("task_id").notNull(),
    itemId: text("item_id").notNull(),
    /** 展開時点のテンプレート版。**更新しない。** */
    templateVersion: integer("template_version").notNull(),
    /**
     * 展開時点の項目の性質を写し取る。テンプレートを後から変えても
     * 「この実施の時点で必須だったか」が変わらないようにするため。
     * `complete` の判定はこの列を見る（テンプレートを引き直さない）。
     */
    isRequired: integer("is_required", { mode: "boolean" }).notNull(),
    photoRequired: integer("photo_required", { mode: "boolean" }).notNull(),
    /** 未実施は null。3 値のいずれかが入ったら実施済み。 */
    value: text("value", { enum: CHECKLIST_VALUES }),
    /** `COULD_NOT` の理由コード（§2.4）。**説明文を求めない**（INV-24）。 */
    reasonCode: text("reason_code"),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
    /** 記録した `membership.id`。 */
    checkedById: text("checked_by_id"),
    ...sortOrderColumn,
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_task_checklist_result_task_item").on(t.organizationId, t.taskId, t.itemId),
    index("idx_task_checklist_result_task").on(t.organizationId, t.taskId, t.sortOrder),
  ],
);
