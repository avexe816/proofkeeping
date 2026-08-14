/**
 * リポジトリ層の入口。
 *
 * task: docs/tasks/P0-07.md
 *
 * **DB へのアクセスはすべてここを通す。** API ハンドラから
 * `getTenantDb()` を呼んで直に `select()` しないこと（PK-SPEC-P0 §19.4 第1層）。
 *
 * `test-support/` はテスト専用のため公開しない。
 */

export {
  ALWAYS_FALSE,
  ALWAYS_TRUE,
  NO_PROPERTY_SCOPE,
  isOrgWideRole,
  scopeToProperties,
  withOrganizationScope,
  withTenantScope,
  type PropertyScope,
  type TenantScopedTable,
} from "./base.js";

export {
  AUDIT_ACTIONS,
  recordAudit,
  type AuditAction,
  type RecordAuditInput,
} from "./audit.js";

export { isModuleEnabled, listEnabledModules } from "./entitlement.js";

// 清掃タスク（P1-01 / P1-03 / P1-05）。
export {
  CLOSED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  appendTimeLog,
  applyInspectionOutcome,
  applyTransition,
  assignTasks,
  cancelPlannedTasks,
  countPhotosByChecklistItem,
  countInspectionSelected,
  countTasksByStatus,
  createTasks,
  findTaskById,
  findTaskByShortId,
  findTimeLogByIdempotencyKey,
  listShortIds,
  listTasks,
  listTimeLogs,
  reviveCancelledTasks,
  updatePlannedTasks,
  type AppendTimeLogInput,
  type ApplyInspectionOutcomeInput,
  type ApplyTransitionInput,
  type AssignTasksOptions,
  type CreateTaskInput,
  type CreateTasksResult,
  type TaskFilter,
  type UpdatePlanInput,
} from "./cleaningTask.js";

// チェックリスト（P1-06）。
export {
  createTemplate,
  deactivateTemplate,
  expandChecklist,
  listChecklistItemsByIds,
  listChecklistResults,
  listTemplateItems,
  listTemplates,
  listTemplatesForProperty,
  recordChecklistResult,
  replaceTemplateItems,
  type CreateChecklistItemInput,
  type CreateTemplateInput,
  type ExpandChecklistInput,
  type RecordChecklistResultInput,
} from "./checklist.js";

// 清掃写真のメタデータ（P1-11）。実体は R2。位置情報の列を持たない（INV-11）。
export {
  countPhotosByTask,
  countTaskPhotos,
  createTaskPhoto,
  findTaskPhotoByClientId,
  findTaskPhotoById,
  listPhotosForChecklistItem,
  listTaskPhotos,
  newPhotoId,
  type CreateTaskPhotoInput,
  type CreateTaskPhotoResult,
} from "./taskPhoto.js";

// 標準時間マスタ（P1-02）。
export {
  listStandardTimes,
  upsertStandardTimes,
  type StandardTimeInput,
} from "./standardTime.js";

// 当日の客室状況（P1-04）。
export {
  listRoomPlans,
  listRoomPlansInRange,
  upsertRoomPlans,
  type RoomPlanInput,
} from "./roomPlan.js";

// 施設ごとの検査方式（P2-02 / PK-SPEC-P2 §2.1）。
// **行が無いことに意味がある。** 読み取りのついでに既定行を作らない。
export {
  findInspectionPolicy,
  legacyPolicyValues,
  listInspectionPolicies,
  upsertInspectionPolicy,
  type InspectionPolicyInput,
} from "./inspectionPolicy.js";

// 検査・検査項目・検査写真・差戻しサイクル（P2-04 / PK-SPEC-P2 §4）。
// **確定した検査を書き換える関数を置かない。** 訂正は次のラウンドで行う。
export {
  advanceReworkCycle,
  completeInspection,
  countInspectionPhotosByItem,
  createInspection,
  createInspectionPhoto,
  createReworkCycle,
  findInspectionById,
  findInspectionByIdempotencyKey,
  findInspectionItemResultById,
  findInspectionPhotoByClientId,
  findOpenInspectionByTask,
  findOpenReworkCycleByTask,
  findReworkCycleById,
  listInspectionItemResults,
  listInspectionPhotos,
  listInspectionsByTask,
  // 日報（P2-14）が 100 室ぶんをまとめて引く。1 室ずつ引かない。
  listInspectionsByTaskIds,
  listReworkCyclesByTask,
  listReworkCyclesByTaskIds,
  newInspectionPhotoId,
  recordInspectionItemResult,
  type AdvanceReworkCycleInput,
  type CompleteInspectionInput,
  type CreateInspectionInput,
  type CreateInspectionPhotoInput,
  type CreateInspectionPhotoResult,
  type CreateReworkCycleInput,
  type RecordInspectionItemResultInput,
} from "./inspection.js";

// 証跡スナップショット（P2-08 / PK-SPEC-P2 §3.7・§6）。
// **INSERT と SELECT だけ。** 更新・削除の関数を足さないこと（§3.7 MUST）。
export {
  appendEvidenceSnapshot,
  findEvidenceSnapshotById,
  findLatestEvidenceSnapshotByTask,
  listEvidenceSnapshotsByDate,
  listEvidenceSnapshotsByTask,
  type AppendEvidenceSnapshotInput,
} from "./evidence.js";

// 当日の施設訪問順（P1-21 / §19.5）。**読み取りのみ。未登録でも一覧は動く。**
export { listDailyRoute } from "./dailyRoute.js";

export {
  findOrganization,
  findTaxProfile,
  updateOrganizationSettings,
  updateTaxProfile,
  type UpdateTaxProfileInput,
} from "./organization.js";

export {
  createProperty,
  createRoomType,
  findPropertyByCode,
  findPropertyById,
  findRoomTypeById,
  listProperties,
  listRoomTypes,
  updateRoomType,
  type CreatePropertyInput,
  type CreateRoomTypeInput,
  type CreateRoomTypeResult,
  type PropertyFilter,
  type RoomTypeFilter,
  type UpdateRoomTypeInput,
} from "./property.js";

export {
  countRoomsByRoomType,
  countSellableRoomsByProperty,
  createRooms,
  findRoomById,
  listFloors,
  listRooms,
  setHousekeepingStatus,
  setRoomSaleStatus,
  updateRoom,
  type CreateRoomInput,
  type CreateRoomsResult,
  type RoomFilter,
  type UpdateRoomInput,
} from "./room.js";

// 日次集計（P0-21）。施設サマリーはここからのみ取る。
export { findPropertyRollup, listPropertyRollups } from "./rollup.js";

export {
  PASSWORD_HISTORY_GENERATIONS,
  findMembershipByUserId,
  findMembershipStartedAt,
  findUserById,
  findUserByStaffNumber,
  listAssignedPropertyIds,
  listPropertyStaff,
  listRecentPasswordHashes,
  listUsers,
  recordLoginAttempt,
  setPasswordHash,
  setUserLocale,
  type LoginAttemptInput,
  type PropertyStaff,
  type SetPasswordHashInput,
  type UserFilter,
} from "./user.js";

// 忘れ物（P2-11 / PK-SPEC-P2 §3.5・§7）。**持ち主の情報を受け取る関数が無い。**
export {
  advanceLostItem,
  countLostItemPhotos,
  createLostItem,
  createLostItemPhoto,
  findLostItemById,
  listLostItemHistory,
  listLostItemPhotos,
  listLostItems,
  markOwnerContacted,
  maxLostItemSequence,
  type AdvanceLostItemInput,
  type AdvanceLostItemResult,
  type CreateLostItemInput,
  type CreateLostItemPhotoInput,
  type CreateLostItemResult,
  type LostItemFilter,
} from "./lostItem.js";

// 設備不具合（P2-12 / 同 §3.6・§8）。**客室を書く関数が無い**（§8.3）。
export {
  advanceIssueReport,
  createIssuePhoto,
  createIssueReport,
  findIssueReportById,
  listIssueHistory,
  listIssuePhotos,
  listIssueReports,
  type AdvanceIssueReportInput,
  type AdvanceIssueReportResult,
  type CreateIssuePhotoInput,
  type CreateIssueReportInput,
  type IssueReportFilter,
} from "./issueReport.js";

// 日報（P2-14 / PK-SPEC-P2 §9）。**発行済み帳票。UPDATE / DELETE が無い。**
// 再生成は revision を上げた新しい行（§9.3）。
export {
  createDailyReport,
  findDailyReportById,
  findLatestDailyReport,
  listDailyReports,
  type CreateDailyReportInput,
  type DailyReportFilter,
  type DailyReportRow,
} from "./dailyReport.js";

// 観察記録・リネン・観察設定（P3-03〜P3-07 / P3-11 / PK-SPEC-P3 §2）。
// **消す関数が無い。** 訂正は `amendObservation()`（旧値を履歴へ積む / §2.2）。
export {
  amendObservation,
  findObservationById,
  findObservationByTaskId,
  findObservationConfig,
  listLinenRecords,
  listLinenRecordsInRange,
  listObservationConfigs,
  listObservationRevisions,
  listObservations,
  skipObservation,
  upsertLinenRecords,
  upsertObservation,
  upsertObservationConfig,
  type AmendObservationInput,
  type LinenEntryInput,
  type LinenRangeFilter,
  type ObservationCountsInput,
  type ObservationFilter,
  type UpsertLinenRecordsInput,
  type UpsertObservationConfigInput,
  type UpsertObservationInput,
  type UpsertObservationResult,
} from "./observation.js";

// 消耗ベースラインと除外記録（P3-09 / P3-10 / P3-12 / PK-SPEC-P3 §2.4・§5）。
// **手動上書き（`manualOverride`）は週次バッチで消えない**（同 §5.5 MUST）。
export {
  clearBaselineOverride,
  findBaselineById,
  listBaselineExclusions,
  listBaselines,
  replaceBaselineExclusions,
  replaceBaselines,
  setBaselineOverride,
  type BaselineExclusionFilter,
  type BaselineExclusionRowInput,
  type BaselineFilter,
  type BaselineRowInput,
  type ReplaceBaselineExclusionsInput,
  type ReplaceBaselinesInput,
  type ReplaceBaselinesResult,
  type SetBaselineOverrideInput,
} from "./baseline.js";

// 稼働記録（P4-02 / PK-SPEC-P4 §2.1・§8.1）。
// **取込元（`source`）ごとに別の行**（DECISIONS #106）。内容が同じ再取込は
// 書き込みそのものを行わない（同 §10.2）。
export {
  MAX_AUDIT_CHANGES,
  findOccupancySnapshotById,
  listOccupancySnapshots,
  upsertOccupancySnapshots,
  type OccupancyFieldChange,
  type OccupancyFilter,
  type OccupancySnapshotInput,
  type UpsertOccupancyParams,
  type UpsertOccupancyResult,
} from "./occupancy.js";
