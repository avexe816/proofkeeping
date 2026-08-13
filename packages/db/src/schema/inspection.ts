/**
 * 検査・差戻し・証跡スナップショット。
 *
 * task: docs/tasks/P2-01.md
 * 仕様: docs/PK-SPEC-P2.md §2.1（検査方式）/ §3.2〜§3.4（検査・差戻し）/ §3.7（証跡）
 * ルール: .claude/rules/architecture.md §2
 *
 * ── 仕様に無い列を 2 つだけ足してある ────────────────────
 * `inspectionItemResult` / `inspectionPhoto` は §3.3 では `inspectionId` /
 * `itemResultId` しか持たない。ここでは `organizationId` と `propertyId` を
 * 足した。**親を辿らないと組織が分からない表を作らないため。**
 * `withTenantScope()` は表そのものの `organizationId` に `eq()` を張る設計で
 * （`repositories/base.ts`）、親経由の JOIN で絞る形にすると第 1 層が
 * 掛からない行が生まれる。`schema.spec.ts` も全テナント表に
 * `organization_id` を要求している。`propertyId` は施設スコープロールの
 * 絞り込み（`scopeToProperties()`）に要る。
 *
 * ── payload は text（JSON 文字列）─────────────────────────
 * 仕様の `Json` 型は D1（SQLite）に無い。**正規化済みの文字列をそのまま
 * 持つ。** `payloadSha256` はこの文字列に対するハッシュなので、
 * ORM 側で再シリアライズすると鍵の並びが変わってハッシュが再現しなくなる。
 * 読み書きはリポジトリ層でのみ行い、JSON へ戻すのは表示の直前にする。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn, timestamps } from "./columns.js";

// ────────────────────────────────────────────────────────────
// 語彙（PK-SPEC-P2 §2.1 / §3.1 / §3.3 / §3.4 / §3.7）
// ────────────────────────────────────────────────────────────

/** 施設ごとの検査方式（§2.1 の `InspectionMode`）。 */
export const INSPECTION_MODES = ["ALL", "SAMPLE", "NONE"] as const;

export type InspectionMode = (typeof INSPECTION_MODES)[number];

/** 検査の判定（§3.1 の `InspectionResult`）。 */
export const INSPECTION_RESULTS = ["PASS", "FAIL"] as const;

export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

/**
 * 検査を省略した理由（§3.1 の `InspectionSkipReason`）。
 *
 * **「検査なし」を「検査合格」として集計しない**（§2.3）。そのために
 * `inspectionResult` と `inspectionSkipReason` を別の列に分けてある。
 */
export const INSPECTION_SKIP_REASONS = ["POLICY_NONE", "NOT_SAMPLED", "EMERGENCY_OVERRIDE"] as const;

export type InspectionSkipReason = (typeof INSPECTION_SKIP_REASONS)[number];

/** 検査項目 1 件の判定（§3.3 の `InspectionItemStatus`）。 */
export const INSPECTION_ITEM_STATUSES = ["PASS", "FAIL", "NOT_APPLICABLE"] as const;

export type InspectionItemStatus = (typeof INSPECTION_ITEM_STATUSES)[number];

/**
 * 不合格の理由コード（§3.3 の `DefectCode`）。
 *
 * **閉じた語彙にしてあるのは集計のため**（§10.1 の「差戻し理由の内訳」）。
 * 自由記述だけにすると理由の分布が出せない。当てはまらない場合の
 * `OTHER` は用意するが、`note` を必須にして裸の `OTHER` を残さない
 * （検証は `packages/contracts` 側）。
 */
export const DEFECT_CODES = [
  "DUST",
  "HAIR",
  "STAIN",
  "ODOR",
  "WATER_SPOT",
  "MISSING_AMENITY",
  "LINEN_WRINKLE",
  "BED_MAKING",
  "TRASH_REMAINING",
  "EQUIPMENT_NOT_RESET",
  "DAMAGE",
  "OTHER",
] as const;

export type DefectCode = (typeof DEFECT_CODES)[number];

/** 差戻しサイクルの状態（§3.4 の `ReworkStatus`）。 */
export const REWORK_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "WAIVED"] as const;

export type ReworkStatus = (typeof REWORK_STATUSES)[number];

/** 証跡の種別（§3.7 の `EvidenceType`）。 */
export const EVIDENCE_TYPES = [
  "CLEANING_COMPLETION",
  "INSPECTION_PASS",
  "INSPECTION_FAIL",
  "REWORK_COMPLETION",
  "DAILY_REPORT",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** 証跡 payload のスキーマ版。**形を変える task が上げること。** */
export const EVIDENCE_SCHEMA_VERSION = "1";

// ────────────────────────────────────────────────────────────
// 表
// ────────────────────────────────────────────────────────────

/**
 * 施設ごとの検査方式（§2.1）。
 *
 * ── `property.inspectionRequired` を消していない ─────────
 * P1 の `property.inspectionRequired`（真偽）はまだ生きている。
 * この表が無い施設では従来どおりその列で判定する（`mode` の既定は
 * 「施設の設定に従う」ではなく、行そのものが無い状態を許す形）。
 * architecture.md §6 の「後方互換のみ・破壊的変更は 3 段階」に従い、
 * 旧列の削除は移行（P2-16）を通した次リリースで行う。
 *
 * ── 1 施設 1 行 ─────────────────────────────────────────
 * 仕様の `propertyId @unique` を `(organizationId, propertyId)` で張る。
 */
export const propertyInspectionPolicy = sqliteTable(
  "property_inspection_policy",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    mode: text("mode", { enum: INSPECTION_MODES }).notNull().default("ALL"),
    /** 抽出率 0〜100（%）。`mode = SAMPLE` のときだけ効く。 */
    sampleRate: integer("sample_rate").notNull().default(100),
    /** 1 日あたりの最低抽出件数。抽出率が低くても検査が 0 件にならないようにする。 */
    minDailySample: integer("min_daily_sample").notNull().default(3),
    /** 当日チェックインがある客室を必ず検査する（§2.2）。 */
    alwaysInspectCheckin: integer("always_inspect_checkin", { mode: "boolean" })
      .notNull()
      .default(true),
    /** 前回差戻しとなったタスクを必ず検査する（同）。 */
    alwaysInspectRework: integer("always_inspect_rework", { mode: "boolean" })
      .notNull()
      .default(true),
    /**
     * 清掃担当者本人による検査を許すか。**既定は false**
     * （security.md §1 / §P2 固有の絶対ルール）。true にしても
     * 理由と監査ログは必須（P2-04）。
     */
    selfInspectionAllowed: integer("self_inspection_allowed", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 検査担当者を自動割当するか（§5.1）。 */
    autoAssignInspector: integer("auto_assign_inspector", { mode: "boolean" })
      .notNull()
      .default(true),
    /** 検査未着手の警告しきい値（分 / §5.2）。**通知はしない。画面内表示のみ。** */
    inspectionSlaMinutes: integer("inspection_sla_minutes").notNull().default(20),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_inspection_policy_property").on(t.organizationId, t.propertyId)],
);

/**
 * 検査 1 回ぶん（§3.2）。
 *
 * ── ラウンドで一意 ──────────────────────────────────────
 * `(taskId, round)` が一意。**再検査は行を足す。** 前の検査を更新しない。
 * 「差戻し → 再清掃 → 再検査の履歴が欠落なく残る」（§16.1）はこの形で満たす。
 *
 * ── `result` は完了時に確定する ─────────────────────────
 * 開始した時点では判定が無い。**null を許す。** 1 項目でも FAIL があれば
 * 全体が FAIL になる集約は `packages/engine` の純粋関数が行い、
 * 検査者が全体だけを PASS に上書きする経路を作らない（§4.3 MUST）。
 */
export const inspection = sqliteTable(
  "inspection",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    taskId: text("task_id").notNull(),
    /** 1, 2, 3…。`cleaningTask.currentInspectionRound + 1`。 */
    round: integer("round").notNull(),
    /** 検査担当者の `membership.id`。 */
    inspectorId: text("inspector_id").notNull(),
    /** 完了までは null。 */
    result: text("result", { enum: INSPECTION_RESULTS }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    durationSeconds: integer("duration_seconds"),
    /** 清掃担当者本人が検査した（§4.2 の例外）。**理由と監査ログが必須。** */
    selfApproved: integer("self_approved", { mode: "boolean" }).notNull().default(false),
    overrideReason: text("override_reason"),
    generalNote: text("general_note"),
    /** 端末側の時刻。**参考値**（`taskTimeLog.clientTs` と同じ扱い）。 */
    clientTs: integer("client_ts", { mode: "timestamp_ms" }),
    /** 再送の重複を弾く鍵（§14.1「全状態変更 API に Idempotency-Key 必須」）。 */
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_inspection_task_round").on(t.organizationId, t.taskId, t.round),
    uniqueIndex("uq_inspection_idempotency").on(t.organizationId, t.idempotencyKey),
    index("idx_inspection_property_completed").on(
      t.organizationId,
      t.propertyId,
      t.completedAt,
    ),
    index("idx_inspection_inspector_completed").on(
      t.organizationId,
      t.inspectorId,
      t.completedAt,
    ),
  ],
);

/**
 * 検査項目 1 件の結果（§3.3）。
 *
 * ── 初期値を持たせない ──────────────────────────────────
 * `status` に既定値を置かない。**全 PASS で初期化しないこと**
 * （P2 固有の絶対ルール）。行が無い＝まだ見ていない、である。
 *
 * ── `reworkRequired` は項目に付く ───────────────────────
 * 差戻しは人ではなく項目に紐づける（§1.2）。担当者名は
 * `reworkCycle.assignedToId` にしか出てこない。
 */
export const inspectionItemResult = sqliteTable(
  "inspection_item_result",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    inspectionId: text("inspection_id").notNull(),
    /** `checklistItem.id`。清掃時の `taskChecklistResult` と同じ項目を指す。 */
    checklistItemId: text("checklist_item_id").notNull(),
    status: text("status", { enum: INSPECTION_ITEM_STATUSES }).notNull(),
    defectCode: text("defect_code", { enum: DEFECT_CODES }),
    note: text("note"),
    reworkRequired: integer("rework_required", { mode: "boolean" }).notNull().default(false),
    reworkDueAt: integer("rework_due_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_inspection_item_result").on(
      t.organizationId,
      t.inspectionId,
      t.checklistItemId,
    ),
    index("idx_inspection_item_result_status").on(
      t.organizationId,
      t.inspectionId,
      t.status,
    ),
  ],
);

/**
 * 不合格項目の写真（§3.3）。
 *
 * `taskPhoto` と別の表にしてあるのは、**清掃の記録と検査の記録を
 * 混ぜないため**（証跡 ZIP も `cleaning-*` と `inspection-*` に分かれる / §6.5）。
 * **EXIF の GPS を持つ列を作らない**（security.md §4 / INV-11）。
 */
export const inspectionPhoto = sqliteTable(
  "inspection_photo",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    /** `inspectionItemResult.id`。 */
    itemResultId: text("item_result_id").notNull(),
    /** 一覧・ZIP で親検査から辿るために持つ（項目を経由しない）。 */
    inspectionId: text("inspection_id").notNull(),
    storageKey: text("storage_key").notNull(),
    /** アップロード時にサーバーが計算したバイナリの SHA-256（§6.3）。 */
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    fileSize: integer("file_size").notNull(),
    /** EXIF の撮影時刻。**GPS は保存しない。** */
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }),
    /** アップロードした `membership.id`。 */
    uploadedById: text("uploaded_by_id").notNull(),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull(),
    /** 端末側で採番する uuid。再送で R2 へ二重書き込みしないための鍵。 */
    clientId: text("client_id").notNull(),
  },
  (t) => [
    uniqueIndex("uq_inspection_photo_client_id").on(t.organizationId, t.clientId),
    index("idx_inspection_photo_item").on(t.organizationId, t.itemResultId),
    index("idx_inspection_photo_inspection").on(t.organizationId, t.inspectionId),
  ],
);

/**
 * 差戻しサイクル（§3.4）。
 *
 * 1 回の不合格につき 1 行。`(taskId, round)` が一意で、
 * `inspection` と同じラウンド番号で対応する。
 *
 * ── Waive（免除）もここに落ちる ─────────────────────────
 * §4.7 の免除は `status = WAIVED` と `waivedById` / `waivedReason` で表す。
 * **行を消さない。** 免除したという事実が証跡に要る。
 */
export const reworkCycle = sqliteTable(
  "rework_cycle",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    taskId: text("task_id").notNull(),
    inspectionId: text("inspection_id").notNull(),
    round: integer("round").notNull(),
    /** 再清掃の担当者の `membership.id`。既定は元の清掃担当者。 */
    assignedToId: text("assigned_to_id").notNull(),
    status: text("status", { enum: REWORK_STATUSES }).notNull().default("OPEN"),
    /**
     * 差戻し理由の要約。**項目の理由コードを連ねた文字列**であって、
     * 担当者の評価ではない（§1.3）。
     */
    reasonSummary: text("reason_summary").notNull(),
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    waivedById: text("waived_by_id"),
    waivedReason: text("waived_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_rework_cycle_task_round").on(t.organizationId, t.taskId, t.round),
    index("idx_rework_cycle_assignee_status").on(
      t.organizationId,
      t.assignedToId,
      t.status,
    ),
  ],
);

/**
 * 証跡スナップショット（§3.7 / §6）。
 *
 * ── INSERT だけ ─────────────────────────────────────────
 * **UPDATE / DELETE を行わない**（§3.7 MUST / CLAUDE.md §4）。
 * リポジトリ層に更新・削除関数を置かない。訂正は
 * `correctsSnapshotId` を持つ新しい行を足す（§6.4）。
 *
 * ── ハッシュ連鎖 ────────────────────────────────────────
 * ```
 * payloadSha256 = sha256(canonicalJson(payload))
 * chainHash     = sha256((previousHash ?? "GENESIS") + payloadSha256)
 * ```
 * `previousHash` は**同一タスク内の直前のスナップショットの `chainHash`**。
 * 途中の 1 件を書き換えると以降の連鎖が合わなくなる。
 *
 * **これを法的タイムスタンプと表現しないこと**（§6.1 / P2 固有の絶対ルール）。
 * 外部の時刻認証は導入していない。示せるのは「保存後に書き換えられていない」
 * ことだけで、「その時刻に存在した」ことではない。
 */
export const evidenceSnapshot = sqliteTable(
  "evidence_snapshot",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    /** 日報など、タスクに紐づかない証跡がある。 */
    taskId: text("task_id"),
    /** 業務日 `YYYY-MM-DD`（architecture.md §7）。 */
    businessDate: text("business_date").notNull(),
    evidenceType: text("evidence_type", { enum: EVIDENCE_TYPES }).notNull(),
    schemaVersion: text("schema_version").notNull(),
    /** 正規化済み JSON の**文字列**。再シリアライズしないこと（冒頭の注記）。 */
    payload: text("payload").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    /** 同一タスク内の前スナップショットの `chainHash`。先頭は null。 */
    previousHash: text("previous_hash"),
    chainHash: text("chain_hash").notNull(),
    /** 訂正元（§6.4）。**元の行は残る。** */
    correctsSnapshotId: text("corrects_snapshot_id"),
    correctionReason: text("correction_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** 生成した `membership.id`。バッチ生成では null。 */
    createdById: text("created_by_id"),
  },
  (t) => [
    index("idx_evidence_task_created").on(t.organizationId, t.taskId, t.createdAt),
    index("idx_evidence_property_date_type").on(
      t.organizationId,
      t.propertyId,
      t.businessDate,
      t.evidenceType,
    ),
  ],
);
