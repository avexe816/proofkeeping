/**
 * 忘れ物と設備不具合。
 *
 * task: docs/tasks/P2-11.md, docs/tasks/P2-12.md
 * 仕様: docs/PK-SPEC-P2.md §3.5（忘れ物）/ §3.6（不具合・修繕）/ §7 / §8
 * ルール: .claude/rules/security.md §3（保存してはいけないデータ）
 *
 * ── 宿泊者の情報を持つ列が 1 つも無い ───────────────────
 * §7.4 / security.md §3。**氏名・住所・電話番号・メールを保存しない。**
 * 連絡は PMS 側で行い、ここには `ownerContactedAt`（連絡した時刻）だけを
 * 残す。**「誰に連絡したか」を書ける列を後から足さないこと。**
 * `description`（品物の説明）は自由記述だが、これは**落とし物そのものの
 * 見た目**を書く欄で、持ち主を書く欄ではない。§7.5 は現金の金額すら
 * ここへ書かないと定めている。
 *
 * ── 仕様に無い列を足してある ────────────────────────────
 * `LostItemPhoto` / `LostItemHistory` / `IssuePhoto` / `IssueHistory` は
 * §3.5 / §3.6 では親の ID しか持たない。`organizationId` と `propertyId` を
 * 足したのは `inspection.ts` 冒頭と同じ理由（親を辿らないと組織が
 * 分からない表を作らない / `withTenantScope()` が掛からなくなる）。
 *
 * ── 状態の履歴を別表にしてある ──────────────────────────
 * §3.5 / §3.6 のモデルどおり。**現在の状態は親が持ち、履歴は追記だけ。**
 * 履歴に UPDATE / DELETE を書かないこと（`repositories.spec.ts` が
 * 全リポジトリのソースを走査して固定する）。
 *
 * ── 自動廃棄をしないための形 ────────────────────────────
 * §7.3 MUST。`retentionDueAt` は**期限を持つだけ**で、過ぎても何も起きない。
 * 状態を変えるのは責任者の明示操作（`DISPOSED` への遷移）だけ。
 * **`retentionDueAt` を見て状態を書き換えるバッチを作らないこと。**
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn, timestamps } from "./columns.js";

// ────────────────────────────────────────────────────────────
// 語彙（PK-SPEC-P2 §3.5 / §3.6）
// ────────────────────────────────────────────────────────────

/** 忘れ物の区分（§3.5 の `LostItemCategory`）。 */
export const LOST_ITEM_CATEGORIES = [
  /** 財布・現金・カード・鍵・スマートフォン等。**§7.3 で最も短い期限。** */
  "VALUABLE",
  "ELECTRONICS",
  "CLOTHING",
  "BAG",
  "MEDICINE",
  "FOOD",
  "DOCUMENT",
  "OTHER",
] as const;

export type LostItemCategory = (typeof LOST_ITEM_CATEGORIES)[number];

/**
 * 忘れ物の状態（§3.5 の `LostItemStatus`）。
 *
 * **`DISPOSED` は終端で、期限では到達しない**（§7.3 MUST）。
 * 責任者が明示的に選んだときだけ入る。
 */
export const LOST_ITEM_STATUSES = [
  "FOUND",
  "STORED",
  "REPORTED_TO_POLICE",
  "RETURN_PENDING",
  "RETURNED",
  "DISPOSED",
  "TRANSFERRED",
] as const;

export type LostItemStatus = (typeof LOST_ITEM_STATUSES)[number];

/** 不具合の区分（§3.6 の `IssueCategory`）。 */
export const ISSUE_CATEGORIES = [
  "CLEANING",
  "PLUMBING",
  "ELECTRICAL",
  "HVAC",
  "FURNITURE",
  "AMENITY",
  "SAFETY",
  "OTHER",
] as const;

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/**
 * 不具合の重要度（§3.6 / §8.2）。
 *
 * **`CRITICAL` だけが客室を自動で止める**（§8.2 MUST）。
 * `HIGH` は「原則 BLOCKED」で、判断は責任者に残す。
 */
export const ISSUE_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** 不具合の状態（§3.6 の `IssueStatus`）。 */
export const ISSUE_STATUSES = [
  "OPEN",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
  "WONT_FIX",
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

// ────────────────────────────────────────────────────────────
// 忘れ物（§3.5 / §7）
// ────────────────────────────────────────────────────────────

/**
 * 拾得物。
 *
 * ── `managementNo` の一意性 ─────────────────────────────
 * §3.5 は `@unique`（全体で一意）だが、**組織 × 施設で一意にしてある。**
 * 番号の形が `LNF-{施設コード}-{YYYYMMDD}-{連番}`（§7.2）で施設コードを
 * 含むため、組織をまたいで衝突するのは施設コードが同じときだけ。
 * それでも組織を鍵に含めるのは、**シャードが違えば全体一意を保証できない**
 * ため（16 シャードにまたがる UNIQUE は張れない）。
 * 全体一意を約束する列を作ると、守れない約束が仕様に残る。
 */
export const lostItem = sqliteTable(
  "lost_item",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    /** 発見時の清掃タスク。タスク外での発見もあるので null 可。 */
    taskId: text("task_id"),
    roomId: text("room_id").notNull(),
    /** 業務日 `YYYY-MM-DD`（architecture.md §7）。 */
    businessDate: text("business_date").notNull(),
    /** `LNF-{施設コード}-{YYYYMMDD}-{4桁}`（§7.2）。 */
    managementNo: text("management_no").notNull(),
    category: text("category", { enum: LOST_ITEM_CATEGORIES }).notNull(),
    /**
     * 品物の説明。**持ち主のことを書く欄ではない**（冒頭の注記）。
     * §7.5: 現金の金額をここへ書かない。
     */
    description: text("description").notNull(),
    foundAt: integer("found_at", { mode: "timestamp_ms" }).notNull(),
    /** 発見した `membership.id`。 */
    foundById: text("found_by_id").notNull(),
    /** 発見場所（「ベッド下」等）。客室内の位置で、住所ではない。 */
    foundLocation: text("found_location").notNull(),
    status: text("status", { enum: LOST_ITEM_STATUSES }).notNull().default("FOUND"),
    /** 保管場所。**`CLEANER` に見せない**（security.md §1 / §7.4）。 */
    storageLocation: text("storage_location"),
    policeReportNo: text("police_report_no"),
    policeReportedAt: integer("police_reported_at", { mode: "timestamp_ms" }),
    /**
     * 持ち主へ連絡した時刻。**連絡先そのものは持たない**（§7.4）。
     * 誰にどう連絡したかは PMS 側にある。
     */
    ownerContactedAt: integer("owner_contacted_at", { mode: "timestamp_ms" }),
    returnedAt: integer("returned_at", { mode: "timestamp_ms" }),
    disposedAt: integer("disposed_at", { mode: "timestamp_ms" }),
    disposalReason: text("disposal_reason"),
    /**
     * 保持期限（§7.3）。**過ぎても何も起きない。**
     * 警告を出すための値で、状態を変える根拠ではない。
     */
    retentionDueAt: integer("retention_due_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_lost_item_management_no").on(t.organizationId, t.propertyId, t.managementNo),
    index("idx_lost_item_property_status").on(t.organizationId, t.propertyId, t.status, t.foundAt),
    // §7.3 の期限警告。**期限の近い順に引く**（自動処理のためではない）。
    index("idx_lost_item_retention").on(t.organizationId, t.retentionDueAt, t.status),
  ],
);

/** 忘れ物の写真（§3.5）。**全体が分かる写真 1 枚が必須**（§7.5）。 */
export const lostItemPhoto = sqliteTable(
  "lost_item_photo",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    lostItemId: text("lost_item_id").notNull(),
    storageKey: text("storage_key").notNull(),
    /** **必須。** 証跡の写真と同じ扱い（§6.3）。 */
    sha256: text("sha256").notNull(),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull(),
    uploadedById: text("uploaded_by_id").notNull(),
  },
  (t) => [index("idx_lost_item_photo_item").on(t.organizationId, t.lostItemId)],
);

/** 忘れ物の状態履歴（§3.5）。**追記だけ。** */
export const lostItemHistory = sqliteTable(
  "lost_item_history",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    lostItemId: text("lost_item_id").notNull(),
    /** 最初の記録は `null`（発見時）。 */
    fromStatus: text("from_status", { enum: LOST_ITEM_STATUSES }),
    toStatus: text("to_status", { enum: LOST_ITEM_STATUSES }).notNull(),
    actorId: text("actor_id").notNull(),
    note: text("note"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_lost_item_history").on(t.organizationId, t.lostItemId, t.occurredAt)],
);

// ────────────────────────────────────────────────────────────
// 設備不具合・修繕（§3.6 / §8）
// ────────────────────────────────────────────────────────────

/**
 * 不具合報告。
 *
 * ── `roomBlocked` は「この報告が客室を止めたか」──────────
 * 客室の現在の状態は `room` が持つ。この列は**この報告が原因で止めたか**
 * を残すためのもので、`RESOLVED` にしても偽へ戻さない（§8.3
 * 「不具合を閉じても客室状態は自動復旧しない」）。**復旧は責任者の
 * 明示操作**（W-03 の手動上書き / `room.statusOverride`）。
 */
export const issueReport = sqliteTable(
  "issue_report",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    /** 発見時の清掃・検査タスク。タスク外の報告もあるので null 可。 */
    taskId: text("task_id"),
    roomId: text("room_id").notNull(),
    category: text("category", { enum: ISSUE_CATEGORIES }).notNull(),
    severity: text("severity", { enum: ISSUE_SEVERITIES }).notNull(),
    /** 定型候補から選ぶ想定（§8.1）。自由記述も許す。 */
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status", { enum: ISSUE_STATUSES }).notNull().default("OPEN"),
    reportedById: text("reported_by_id").notNull(),
    assignedToId: text("assigned_to_id"),
    reportedAt: integer("reported_at", { mode: "timestamp_ms" }).notNull(),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolutionNote: text("resolution_note"),
    /** この報告が客室を止めたか（§8.2）。**解決しても偽へ戻さない。** */
    roomBlocked: integer("room_blocked", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("idx_issue_report_property").on(t.organizationId, t.propertyId, t.status, t.severity),
    index("idx_issue_report_room").on(t.organizationId, t.roomId, t.status),
  ],
);

/** 不具合の写真（§3.6）。**1 枚以上が必須**（§8.1。安全上撮影困難な場合を除く）。 */
export const issuePhoto = sqliteTable(
  "issue_photo",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    issueId: text("issue_id").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull(),
    uploadedById: text("uploaded_by_id").notNull(),
  },
  (t) => [index("idx_issue_photo_issue").on(t.organizationId, t.issueId)],
);

/** 不具合の状態履歴（§3.6）。**追記だけ。** */
export const issueHistory = sqliteTable(
  "issue_history",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    issueId: text("issue_id").notNull(),
    fromStatus: text("from_status", { enum: ISSUE_STATUSES }),
    toStatus: text("to_status", { enum: ISSUE_STATUSES }).notNull(),
    actorId: text("actor_id").notNull(),
    note: text("note"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_issue_history").on(t.organizationId, t.issueId, t.occurredAt)],
);
