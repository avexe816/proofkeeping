/**
 * テナントスコープのスキーマ。`getTenantDb()` に渡す唯一の集合。
 *
 * task: docs/tasks/P0-06.md
 *
 * **全局テーブル（`global.ts`）とメタテーブル（`meta.ts`）をここへ含めない。**
 * ここに載せた表は `getTenantDb()` 経由で引けるようになる。テナント文脈で
 * 全局テーブルを引けてしまうと、テナント横断のクエリ（architecture.md §3 で禁止）が
 * 型の上で自然に書けてしまう。それぞれ `getGlobalDb()` / ランナー専用の経路から使う。
 */

export {
  DOCUMENT_TYPES,
  TAX_ROUNDING_MODES,
  documentSequence,
  organization,
  organizationTaxProfile,
} from "./organization.js";

export {
  ROLES,
  membership,
  passwordHistory,
  propertyAssignment,
  user,
  type Role,
} from "./user.js";

export {
  HOUSEKEEPING_STATUSES,
  ROOM_SOURCE_TYPES,
  building,
  floor,
  property,
  room,
  roomType,
  type HousekeepingStatus,
} from "./property.js";

export {
  BILLING_CYCLES,
  ENTITLEMENT_SOURCES,
  MODULE_CODES,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUSES,
  moduleEntitlement,
  subscription,
  type ModuleCode,
} from "./billing.js";

export { auditLog } from "./audit.js";

// 清掃タスクとその周辺（P1-01）。enum の語彙は PK-SPEC-P1 §2.1 を正とする
// （実装契約書 §2.1 との食い違いは OPEN_QUESTIONS #032）。
export {
  PHOTO_KINDS,
  ROOM_PLAN_SOURCES,
  TASK_SHORT_ID_LENGTH,
  TASK_SOURCE_TYPES,
  TASK_STATUSES,
  TASK_TYPES,
  TIME_EVENTS,
  cleaningTask,
  dailyRoomPlan,
  // 当日の施設訪問順（P1-21 / §19.5）。**未登録でも一覧は動く。**
  dailyRoute,
  standardTime,
  taskPhoto,
  taskTimeLog,
  type PhotoKind,
  type RoomPlanSource,
  type TaskSourceType,
  type TaskStatus,
  type TaskType,
  type TimeEvent,
} from "./task.js";

// チェックリスト（P1-01 / P1-06）。実施結果は 3 値（INV-22）。
export {
  CHECKLIST_VALUES,
  checklistItem,
  checklistTemplate,
  taskChecklistResult,
  type ChecklistValue,
} from "./checklist.js";

// 検査・差戻し・証跡（P2-01 / PK-SPEC-P2 §2.1・§3.2〜§3.4・§3.7）。
// **`evidenceSnapshot` は INSERT のみ。** 更新・削除の関数を作らない。
export {
  DEFECT_CODES,
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_TYPES,
  INSPECTION_ITEM_STATUSES,
  INSPECTION_MODES,
  INSPECTION_RESULTS,
  INSPECTION_SKIP_REASONS,
  REWORK_STATUSES,
  evidenceSnapshot,
  inspection,
  inspectionItemResult,
  inspectionPhoto,
  propertyInspectionPolicy,
  reworkCycle,
  type DefectCode,
  type EvidenceType,
  type InspectionItemStatus,
  type InspectionMode,
  type InspectionResult,
  type InspectionSkipReason,
  type ReworkStatus,
} from "./inspection.js";

// 日次の施設別集計（P0-21）。施設サマリーはここだけを読む（§26 の絶対ルール）。
export { dailyPropertyRollup } from "./rollup.js";

// 外部システムとの ID 対応（P0-22 は定義のみ。使用は P6）。
export { EXTERNAL_ENTITY_TYPES, externalMapping } from "./integration.js";
