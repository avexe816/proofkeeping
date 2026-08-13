/**
 * 清掃タスク・作業時間ログ・写真・標準時間マスタ・当日の客室状況。
 *
 * task: docs/tasks/P1-01.md
 * 仕様: docs/PK-SPEC-P1.md §2.1（データモデル）/ §3.1（生成ルール）
 *
 * ── enum の語彙は PK-SPEC-P1 §2.1 を採った ──────────────
 * `docs/PK-IMPL-CONTRACT.md` §2.1 は `taskType` を
 * `CHECKOUT_CLEAN` / `STAY_CLEAN` / `INSPECTION` / `REWORK`、
 * `status` を `TODO` / `IN_PROGRESS` / `PAUSED` / `ON_HOLD` / `COMPLETED` /
 * `REWORK_REQUIRED` と書いており、**仕様書と食い違う。**
 * §5.1 の状態機械は 9 状態（`CREATED` / `ASSIGNED` / `AWAITING_INSPECTION` /
 * `CANCELLED` を含む）を要求し、契約書の 6 語では表現しきれない。
 * 表現力の広い側を採り、矛盾は docs/OPEN_QUESTIONS.md #032 に起票した。
 * 語彙は永続データなので**後から綴りを変えないこと。**
 *
 * ── 一意制約と index の形 ───────────────────────────────
 * 仕様の `@@unique([roomId, businessDate, taskType])` は
 * `organization_id` を先頭に足した形で張る。`schema.spec.ts` が
 * 「テナントスコープの全 index が organization_id から始まる」を固定しており、
 * 先頭が別の列の index は他組織の行を跨いで走査するクエリを引き寄せるため
 * （テナント分離は index の設計にも現れる）。組織を跨いだ重複は
 * そもそも起こり得ない（`roomId` が自己記述 ID なので組織ごとに異なる）。
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { primaryId, tenantColumn, timestamps } from "./columns.js";
// 検査の語彙は `inspection.ts` が持つ（P2-01）。**逆向きの import を作らないこと。**
// `inspection.ts` は `task.ts` を参照しない（循環になる）。
import { INSPECTION_RESULTS, INSPECTION_SKIP_REASONS } from "./inspection.js";

/** 清掃種別（PK-SPEC-P1 §2.1 の `TaskType`）。 */
export const TASK_TYPES = ["CHECKOUT", "STAYOVER", "DEEP", "COMMON_AREA", "RECHECK"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/**
 * タスクの状態（同 §2.1 の `TaskStatus`）。
 *
 * `AWAITING_INSPECTION` / `REWORK` は **P2 の検査フローで使う。**
 * P1 でも状態としては作る（§1.2 Out of Scope）。検査が不要な施設では
 * `complete` が直接 `COMPLETED` へ進む（§5.2）。
 */
export const TASK_STATUSES = [
  "CREATED",
  "ASSIGNED",
  "IN_PROGRESS",
  "PAUSED",
  "AWAITING_INSPECTION",
  "REWORK",
  "COMPLETED",
  "BLOCKED",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 生成経路（同 §2.1 の `SourceType`）。 */
export const TASK_SOURCE_TYPES = ["AUTO", "MANUAL", "REGENERATED"] as const;

export type TaskSourceType = (typeof TASK_SOURCE_TYPES)[number];

/** 作業時間の実測イベント（同 §2.1 の `TimeEvent`）。 */
export const TIME_EVENTS = ["START", "PAUSE", "RESUME", "COMPLETE", "BLOCK", "UNBLOCK"] as const;

export type TimeEvent = (typeof TIME_EVENTS)[number];

/** 写真の種別（同 §2.1 の `PhotoKind`）。 */
export const PHOTO_KINDS = ["BEFORE", "AFTER", "CHECKLIST", "OTHER"] as const;

export type PhotoKind = (typeof PHOTO_KINDS)[number];

/** 当日の客室状況の入力経路（同 §2.1 の `DailyRoomPlan.source`）。 */
export const ROOM_PLAN_SOURCES = ["MANUAL", "CSV"] as const;

export type RoomPlanSource = (typeof ROOM_PLAN_SOURCES)[number];

/** 直リンク用 `shortId` の桁数（P1-01 完了条件「`shortId` が 8 桁で一意」）。 */
export const TASK_SHORT_ID_LENGTH = 8;

/**
 * 清掃タスク。
 *
 * ── `actualMinutes` はキャッシュに過ぎない ──────────────
 * 真実は `taskTimeLog` にある（§2.2）。中断を挟んだ場合の計算は
 * `packages/engine` の `accumulateActualMinutes()` が行い、
 * ここへ書き戻すのは表示と集計を速くするためだけ。**この列を根拠に
 * 請求や照合をしないこと。**
 *
 * ── `assigneeId` は `membership.id` ────────────────────
 * `user.id` ではない。ロールは組織ごとの所属に紐づくため。
 */
export const cleaningTask = sqliteTable(
  "cleaning_task",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    roomId: text("room_id").notNull(),
    /** 業務日 `YYYY-MM-DD`（architecture.md §7）。カレンダー日ではない。 */
    businessDate: text("business_date").notNull(),
    taskType: text("task_type", { enum: TASK_TYPES }).notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("CREATED"),
    /** 小さいほど優先（§3.1 の生成ルールが与える）。 */
    priority: integer("priority").notNull().default(50),
    /** `membership.id`。未割当は null。 */
    assigneeId: text("assignee_id"),
    standardMinutes: integer("standard_minutes").notNull(),
    /** `taskTimeLog` から再計算した実作業時間（分）。中断時間を含まない。 */
    actualMinutes: integer("actual_minutes"),
    /** 中断回数（PK-IMPL-CONTRACT §2.1 の `pauseCount`）。 */
    pauseCount: integer("pause_count").notNull().default(0),
    /** 差戻し回数。P2 の検査フローが増やす。P1 では 0 のまま。 */
    reworkCount: integer("rework_count").notNull().default(0),
    /**
     * 検査の要否（PK-SPEC-P2 §3.1）。**清掃完了時に確定する。**
     *
     * 施設の `inspectionMode` と必須検査条件から `packages/engine` の
     * `decideInspection()` が決める。**完了前は既定の `false` のまま**で、
     * 抽出対象かどうかを清掃担当者に見せない（§2.2 MUST）。
     */
    inspectionRequired: integer("inspection_required", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 検査を省略した（§2.3）。**これを「検査合格」として集計しないこと。** */
    inspectionSkipped: integer("inspection_skipped", { mode: "boolean" }).notNull().default(false),
    inspectionSkipReason: text("inspection_skip_reason", { enum: INSPECTION_SKIP_REASONS }),
    /** 最後に検査した `membership.id`。履歴は `inspection` 表にある。 */
    inspectorId: text("inspector_id"),
    inspectedAt: integer("inspected_at", { mode: "timestamp_ms" }),
    /** 最新の判定。**省略とは別の列**（§2.3）。 */
    inspectionResult: text("inspection_result", { enum: INSPECTION_RESULTS }),
    /** 実施済みの検査ラウンド数。次の検査は `+ 1`（§4.2）。 */
    currentInspectionRound: integer("current_inspection_round").notNull().default(0),
    sourceType: text("source_type", { enum: TASK_SOURCE_TYPES }).notNull().default("AUTO"),
    note: text("note"),
    blockedReason: text("blocked_reason"),
    /**
     * 直リンク（`/t/{shortId}`）用の 8 桁。**組織内で一意。**
     *
     * 全局一意にしていないのは、リンクを開く時点でセッションが組織を
     * 確定させており（`orgShortId` は Cookie 側にある）、組織を跨いだ
     * 突き合わせが不要なため。全局一意にすると `org_directory` と同種の
     * 全局レジストリがもう 1 つ必要になり、シャード分離の外側が増える。
     */
    shortId: text("short_id").notNull(),
    /**
     * 担当者の当日訪問順（PK-SPEC-P1 §19.5）。
     *
     * **P1-01 では書き込まない。** 複数施設の担当（P1-21〜23）が使う。
     * 仕様で列が確定しているため、後日の ALTER TABLE を避けて
     * 初回の CREATE TABLE に含めてある（`room` の 3 カラムと同じ判断）。
     */
    sequenceInDay: integer("sequence_in_day"),
    assignedAt: integer("assigned_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    ...timestamps,
    // ── P3-01 で足した列。**末尾に置くこと。**  ─────────────
    // 既存の列の間に挿し込むと、`SELECT *` の並びを前提にした
    // fake D1 の行（`apps/web` の spec）が 1 つずつずれる。
    // 物理的にも ALTER TABLE は末尾に足すので、宣言順と一致させる。
    /**
     * 入室時の観察記録を「今回は記録しない」で飛ばした（PK-SPEC-P3 §2.7 / §1.3）。
     *
     * **未記録を責めるための列ではない。** 理由も聞かない（§1.3 MUST）。
     * 未記録のタスクは P4 の照合対象から外れるため、その事実だけを残す。
     * 施設ごとの未記録率が `observationConfig.skipWarnThreshold` を超えたら
     * W-22 が施設単位で警告する（個人単位では出さない / security.md §5）。
     */
    observationSkipped: integer("observation_skipped", { mode: "boolean" })
      .notNull()
      .default(false),
    /** 観察記録を確定した時刻。`roomObservation.recordedAt` の写し。 */
    observationRecordedAt: integer("observation_recorded_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    // §2.2「同一客室・同一業務日・同一種別のタスクは 1 件しか作らない」。
    // バッチの二重実行やリトライで重複が生まれるのを構造的に防ぐ。
    uniqueIndex("uq_cleaning_task_room_date_type").on(
      t.organizationId,
      t.roomId,
      t.businessDate,
      t.taskType,
    ),
    uniqueIndex("uq_cleaning_task_short_id").on(t.organizationId, t.shortId),
    index("idx_cleaning_task_property_date_status").on(
      t.organizationId,
      t.propertyId,
      t.businessDate,
      t.status,
    ),
    index("idx_cleaning_task_assignee_date_status").on(
      t.organizationId,
      t.assigneeId,
      t.businessDate,
      t.status,
    ),
    index("idx_cleaning_task_org_date").on(t.organizationId, t.businessDate),
  ],
);

/**
 * 作業時間の実測ログ。開始・中断・再開・完了をすべて記録する（§2.2）。
 *
 * **UPDATE / DELETE しない。** 訂正は新しい行を足す。`actualMinutes` の
 * 根拠がこの並びなので、書き換えると過去の集計を再現できなくなる。
 *
 * ── `idempotencyKey` ────────────────────────────────────
 * 状態変更 API は `Idempotency-Key` ヘッダに対応する（CLAUDE.md §5）。
 * オフラインキューは同じ操作を何度も再送する（ui-writing.md §5）。
 * **鍵をここに置くのは意図。** 別のストア（KV）に置くと、鍵の記録と
 * イベントの記録が別の失敗単位になり、「鍵だけ残ってイベントが無い」
 * 状態が作れてしまう。一意制約で弾けば、再送は必ず「何も起きない」に倒れる。
 */
export const taskTimeLog = sqliteTable(
  "task_time_log",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    taskId: text("task_id").notNull(),
    event: text("event", { enum: TIME_EVENTS }).notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    /** 操作者の `membership.id`。 */
    actorId: text("actor_id").notNull(),
    /** 中断・入室不可の理由コード（PK-IMPL-CONTRACT §2.2 の `reasonCode`）。 */
    reasonCode: text("reason_code"),
    /**
     * 端末側のタイムスタンプ。**参考値**（オフライン時の順序の手がかり）。
     * 集計には使わない。`occurredAt` はサーバー時刻（同 §2.1）。
     */
    clientTs: integer("client_ts", { mode: "timestamp_ms" }),
    /** 再送の重複を弾く鍵。組織内で一意。 */
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("uq_task_time_log_idempotency").on(t.organizationId, t.idempotencyKey),
    index("idx_task_time_log_task").on(t.organizationId, t.taskId, t.occurredAt),
  ],
);

/**
 * タスクに紐づく写真のメタデータ（§2.1 / §7）。
 *
 * **実体は R2。** キーは `photos/{orgId}/{propertyId}/{businessDate}/{taskId}/{photoId}.jpg`
 * （security.md §4）。アップロードの実装は P1-11。P1-01 は表と、
 * `complete` の写真必須判定に使う読み取りだけを持つ。
 *
 * **EXIF の GPS を持つ列を作らない**（security.md §4 / INV-11）。
 * 保持するのは撮影時刻のみ。
 */
export const taskPhoto = sqliteTable(
  "task_photo",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    taskId: text("task_id").notNull(),
    /** 写真必須のチェックリスト項目に紐づく場合のみ。 */
    checklistItemId: text("checklist_item_id"),
    kind: text("kind", { enum: PHOTO_KINDS }).notNull().default("AFTER"),
    storageKey: text("storage_key").notNull(),
    /**
     * アップロード時にサーバーが計算したバイナリの SHA-256（PK-SPEC-P2 §6.3）。
     *
     * **nullable にしてある。** P1-11 の時点でこの列が無く、既存の行には
     * 値が入らない（architecture.md §6「後方互換のみ」）。証跡の payload は
     * `null` をそのまま載せる — **後から計算して埋めない。** 埋めると
     * 「アップロード時に計算した値」ではなくなり、§6.3 の意味が変わる。
     * `inspectionPhoto.sha256` は最初から必須（P2-01）。
     */
    sha256: text("sha256"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    fileSize: integer("file_size").notNull(),
    /** EXIF の撮影時刻。**GPS は保存しない。** */
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull(),
    /** アップロードした `membership.id`。 */
    uploadedById: text("uploaded_by_id").notNull(),
    /** 端末側で採番する uuid。再送時に R2 へ二重書き込みしないための鍵（§7.5）。 */
    clientId: text("client_id").notNull(),
  },
  (t) => [
    uniqueIndex("uq_task_photo_client_id").on(t.organizationId, t.clientId),
    index("idx_task_photo_task_kind").on(t.organizationId, t.taskId, t.kind),
  ],
);

/**
 * 標準時間マスタ（§2.1 / §3.1 / W-17）。
 *
 * 客室タイプ × 清掃種別で目安時間を持つ。該当が無ければ §3.1 の既定分数。
 * **`roomType` 側に持たせない**（`schema/property.ts` の注記）。
 */
export const standardTime = sqliteTable(
  "standard_time",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    roomTypeId: text("room_type_id").notNull(),
    taskType: text("task_type", { enum: TASK_TYPES }).notNull(),
    minutes: integer("minutes").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_standard_time_property_room_type_task").on(
      t.organizationId,
      t.propertyId,
      t.roomTypeId,
      t.taskType,
    ),
  ],
);

/**
 * 当日の客室状況（§2.1 / §3.4）。
 *
 * P1 では PMS 連携が無いため施設側が入力する簡易テーブル。
 * **P4 の `OccupancySnapshot` とは別物**で、P4 で統合する。
 *
 * **宿泊者の氏名・連絡先・予約者情報の列を作らない**（security.md §3）。
 * 稼働照合に要るのは人数と予約参照番号だけで、それも P4 の表が持つ。
 */
export const dailyRoomPlan = sqliteTable(
  "daily_room_plan",
  {
    ...primaryId,
    ...tenantColumn,
    propertyId: text("property_id").notNull(),
    roomId: text("room_id").notNull(),
    businessDate: text("business_date").notNull(),
    hasCheckout: integer("has_checkout", { mode: "boolean" }).notNull().default(false),
    hasCheckin: integer("has_checkin", { mode: "boolean" }).notNull().default(false),
    isStayover: integer("is_stayover", { mode: "boolean" }).notNull().default(false),
    guestCount: integer("guest_count").notNull().default(0),
    /** 清掃辞退。`isStayover` と併せて「生成しない」を決める（§3.1）。 */
    declineClean: integer("decline_clean", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ROOM_PLAN_SOURCES }).notNull().default("MANUAL"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_daily_room_plan_room_date").on(t.organizationId, t.roomId, t.businessDate),
    index("idx_daily_room_plan_property_date").on(
      t.organizationId,
      t.propertyId,
      t.businessDate,
    ),
  ],
);

/**
 * 当日の施設訪問順と移動時間（PK-SPEC-P1 §19.5）。
 *
 * task: docs/tasks/P1-21.md
 *
 * ── 無くても一覧が動くこと（§19.5 MUST）────────────────
 * この表は**あれば動線が読める**というだけの補助。未登録の担当者は
 * 施設名の昇順でグループ化し、移動ブロックを出さない。
 * `my-day` がこの表を必須にすると、シフトを入力していない組織で
 * 現場の一覧が空になる。**join ではなく突き合わせで使うこと。**
 *
 * ── 粒度は「担当者 × 業務日 × 順番」───────────────────
 * 施設ではなく担当者に紐づく。同じ施設を 2 人が別の順番で回る。
 * `propertyId` を持つのは移動先を示すためで、スコープの主体ではない。
 *
 * ── 予定時刻は文字列、実績は時刻 ────────────────────────
 * `plannedStartAt` は `"09:00"`（施設のローカル時刻）。日付を持たせない。
 * 実績（`actualStartAt` / `actualEndAt`）は epoch ミリ秒。仕様 §19.5 は
 * `mode: "timestamp"`（秒）と書くが、**他の全列が `timestamp_ms` で
 * 揃っている。** 秒と ミリ秒が同じスキーマに混ざるほうが事故を呼ぶ。
 *
 * ── P1 では誰も書かない ─────────────────────────────────
 * 入力画面はシフト管理（P8 Workforce）の担当で、P1-21 の やること にも
 * 無い。読み取りだけを置く。**書き込み関数を「あとで要るから」で
 * 足さないこと**（CLAUDE.md §1-4）。
 */
export const dailyRoute = sqliteTable(
  "daily_route",
  {
    ...primaryId,
    ...tenantColumn,
    /** `membership.id`。**`user.id` ではない**（`cleaningTask.assigneeId` と同じ）。 */
    membershipId: text("membership_id").notNull(),
    /** 業務日 `YYYY-MM-DD`（architecture.md §7）。 */
    businessDate: text("business_date").notNull(),
    /** 訪問順 1, 2, 3...。 */
    sequence: integer("sequence").notNull(),
    propertyId: text("property_id").notNull(),
    /** 予定開始 `"09:00"`。施設のローカル時刻。 */
    plannedStartAt: text("planned_start_at"),
    /** 予定終了 `"13:00"`。 */
    plannedEndAt: text("planned_end_at"),
    /** **次の**施設への移動時間（分）。最後の施設では null。 */
    travelMinutes: integer("travel_minutes"),
    actualStartAt: integer("actual_start_at", { mode: "timestamp_ms" }),
    actualEndAt: integer("actual_end_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (t) => [
    // 仕様 §19.5 の `uq_route` に `organization_id` を先頭で足した形。
    // テナントスコープの index は必ず組織から始める（`schema.spec.ts`）。
    uniqueIndex("uq_daily_route_member_date_seq").on(
      t.organizationId,
      t.membershipId,
      t.businessDate,
      t.sequence,
    ),
    index("idx_daily_route_date").on(t.organizationId, t.businessDate),
  ],
);
