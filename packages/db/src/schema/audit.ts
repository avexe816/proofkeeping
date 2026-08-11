/**
 * 監査ログ。
 *
 * task: docs/tasks/P0-06.md
 * ルール: .claude/rules/security.md §6
 * 契約: docs/PK-IMPL-CONTRACT.md §2.9（INV-30: 削除できない実装とする。保存期間 5 年）
 *
 * ── 消さない ────────────────────────────────────────────
 * UPDATE / DELETE の API を作らない。年次アーカイブの対象からも外す
 * （PK-SPEC-P0 §19.7）。書き込みは `recordAudit()`（P0-11）のみ。
 *
 * ── 載せてはいけないもの ────────────────────────────────
 * `before` / `after` にパスワードハッシュ・PIN ハッシュを含めない（security.md §6）。
 * マスクは `recordAudit()` の責務。宿泊者の情報は元より保存しない（同 §3）。
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn } from "./columns.js";

import { ROLES } from "./user.js";

export const auditLog = sqliteTable(
  "audit_log",
  {
    ...primaryId,
    ...tenantColumn,
    /** 施設スコープの操作なら施設 ID。組織全体の操作は null。 */
    propertyId: text("property_id"),
    /** 操作者の membership ID。 */
    actorId: text("actor_id").notNull(),
    /** 操作時点のロール。後でロールを変えても当時の権限が追える。 */
    actorRole: text("actor_role", { enum: ROLES }).notNull(),
    /** 操作種別。`task.completed` / `inspection.self_approved` のようなドット区切り。 */
    action: text("action").notNull(),
    /** 対象の種別。`room` / `invoice` など。 */
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    /** 修正前の値（JSON 文字列）。 */
    before: text("before"),
    /** 修正後の値（JSON 文字列）。 */
    after: text("after"),
    /** 理由必須の操作（客室ステータスの手動上書き・観察記録の事後修正など）で使う。 */
    reason: text("reason"),
    ip: text("ip"),
    /** 操作時刻。`createdAt` ではなく契約書 §2.9 の `at` を使う。 */
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_audit_log_org_at").on(t.organizationId, t.at),
    index("idx_audit_log_org_target").on(t.organizationId, t.targetId),
    index("idx_audit_log_org_action_at").on(t.organizationId, t.action, t.at),
  ],
);
