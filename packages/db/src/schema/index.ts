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
  ORG_TYPES,
  TAX_ROUNDING_MODES,
  documentSequence,
  organization,
  organizationTaxProfile,
  type OrgType,
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
  ROOM_SALE_STATUSES,
  ROOM_SOURCE_TYPES,
  building,
  floor,
  property,
  room,
  roomType,
  type HousekeepingStatus,
  type RoomSaleStatus,
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

// 忘れ物と設備不具合（P2-11 / P2-12 / PK-SPEC-P2 §3.5・§3.6・§7・§8）。
// **宿泊者の情報を持つ列が 1 つも無い**（security.md §3）。
export {
  ISSUE_CATEGORIES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  LOST_ITEM_CATEGORIES,
  LOST_ITEM_STATUSES,
  issueHistory,
  issuePhoto,
  issueReport,
  lostItem,
  lostItemHistory,
  lostItemPhoto,
  type IssueCategory,
  type IssueSeverity,
  type IssueStatus,
  type LostItemCategory,
  type LostItemStatus,
} from "./report.js";

// 日次の施設別集計（P0-21）。施設サマリーはここだけを読む（§26 の絶対ルール）。
export { dailyPropertyRollup } from "./rollup.js";

// 日報（P2-14 / PK-SPEC-P2 §9.4）。**発行済み帳票。UPDATE / DELETE しない。**
export { dailyReport } from "./dailyReport.js";

// 観察記録・リネン・ベースライン（P3-01 / PK-SPEC-P3 §2）。
// **P3 は判定しない**（§0.2）。ここにあるのは観察値と統計量だけ。
export {
  AMENITY_ITEM_CODES,
  BASELINE_EXCLUSION_REASONS,
  ITEM_CODES,
  LINEN_ITEM_CODES,
  TRASH_LEVELS,
  baselineExclusionLog,
  consumptionBaseline,
  linenRecord,
  observationConfig,
  observationRevision,
  roomObservation,
  type BaselineExclusionReason,
  type ItemCode,
  type TrashLevel,
} from "./observation.js";

// 稼働照合（P4-01 / PK-SPEC-P4 §2）。
// **`auditFinding` は差異であって不正の認定ではない**（§1.1）。
// `occupancySnapshot` に宿泊者の氏名・連絡先の列は無い（§2.1 MUST）。
export {
  DETECTION_OUTCOMES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  OCCUPANCY_CHANNEL_CODES,
  OCCUPANCY_SOURCES,
  RECONCILIATION_RUN_STATUSES,
  RECONCILIATION_SOURCES,
  ROOM_ACCESS_PURPOSES,
  RULE_CODES,
  SIGNAL_ACTOR_TYPES,
  SIGNAL_TYPES,
  auditFinding,
  detectionFeedback,
  occupancySnapshot,
  physicalSignal,
  reconciliationRun,
  roomAccessLog,
  ruleConfig,
  type DetectionOutcome,
  type FindingSeverity,
  type FindingStatus,
  type OccupancyChannelCode,
  type OccupancySource,
  type ReconciliationRunStatus,
  type ReconciliationSource,
  type RoomAccessPurpose,
  type RuleCode,
  type SignalActorType,
  type SignalType,
} from "./reconciliation.js";

// 外部連携（P6-01 / PK-SPEC-P6 §2・§6）。`externalMapping` は P0-22 が
// 定義だけ置いた表で、読み書きは P6 から。
// **平文の資格情報を持つ列が 1 つも無い**（security.md §7 / DECISIONS #138）。
// 仕様 §2.1 の `webhookSecret` と §6.4 の `secret` は KV の参照キーに読み替えてある。
export {
  API_SCOPES,
  ARCHIVE_RESTORE_STATUSES,
  EXTERNAL_ENTITY_TYPES,
  INTEGRATION_KINDS,
  INTEGRATION_STATUSES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_CODES,
  OUTBOUND_WEBHOOK_EVENTS,
  SYNC_DIRECTIONS,
  SYNC_MODES,
  SYNC_STATUSES,
  SYNC_TRIGGERS,
  apiKey,
  archiveManifest,
  archiveRestore,
  archiveRestoreRow,
  externalMapping,
  integration,
  notificationPreference,
  outboundWebhook,
  pushSubscription,
  syncLog,
  type ApiScope,
  type ArchiveRestoreStatus,
  type ExternalEntityType,
  type IntegrationKind,
  type IntegrationStatus,
  type NotificationChannel,
  type NotificationEventCode,
  type OutboundWebhookEvent,
  type SyncDirection,
  type SyncMode,
  type SyncStatus,
  type SyncTrigger,
} from "./integration.js";

// 請求・領収（P5-01 / PK-SPEC-P5 §2）。
// **発行済み帳票は消せない**（billing.md §2）。訂正は赤伝＋再発行。
// 電子帳簿保存法の検索 3 項目（取引年月日・取引金額・取引先）を
// 非正規化して索引を張ってある（§1.2 MUST）。
export {
  BILLING_PERIOD_REVIEW_ACTIONS,
  BILLING_PERIOD_STATUSES,
  DELIVERY_CHANNELS,
  DELIVERY_DOC_TYPES,
  DELIVERY_STATUSES,
  INVOICE_ITEM_CODES,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  RECEIPT_STATUSES,
  ROOM_UNIT,
  billingPeriod,
  billingPeriodReview,
  counterparty,
  documentDelivery,
  invoice,
  invoiceLine,
  invoiceTaxSummary,
  pricingRule,
  receipt,
  type BillingPeriodReviewAction,
  type BillingPeriodReviewLineComment,
  type BillingPeriodReviewLineSnapshot,
  type BillingPeriodStatus,
  type DeliveryChannel,
  type DeliveryDocType,
  type DeliveryStatus,
  type InvoiceItemCode,
  type InvoiceStatus,
  type PaymentMethod,
  type ReceiptStatus,
} from "./invoice.js";

// スタッフ台帳と支払集計（P5-18 / P8-01 / docs/PK-SPEC-PAY.md / PK-SPEC-P8 §1.3）。
// **控除の列は無い**（支給総額の基礎まで）。個人情報の列も無い（PAY §1.1 MUST）。
// `staffPayProfile` は P8-01 で台帳そのものになった（DECISIONS #223）。
export {
  EMPLOYMENT_TYPES,
  PAY_UNIT_TYPES,
  PAYOUT_LINE_TYPES,
  PAYOUT_PERIOD_STATUSES,
  WORK_STATUSES,
  payoutLine,
  payoutPeriod,
  payRule,
  staffPayProfile,
  type EmploymentType,
  type PayoutLineType,
  type PayoutPeriodStatus,
  type PayUnitType,
  type WorkStatus,
} from "./payout.js";

// Workforce（P8-02 / 在留資格）。**番号も国籍も持たない**（security.md §3）。
export {
  RESIDENCY_STATUS_TYPES,
  residencyRecord,
  type ResidencyStatusType,
} from "./workforce.js";
