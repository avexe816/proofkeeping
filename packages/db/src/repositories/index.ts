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
  applyTransition,
  assignTasks,
  cancelPlannedTasks,
  countPhotosByChecklistItem,
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
  upsertRoomPlans,
  type RoomPlanInput,
} from "./roomPlan.js";

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
  findPropertyByCode,
  findPropertyById,
  listProperties,
  listRoomTypes,
  type CreatePropertyInput,
  type PropertyFilter,
} from "./property.js";

export {
  countSellableRoomsByProperty,
  createRooms,
  findRoomById,
  listFloors,
  listRooms,
  setHousekeepingStatus,
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
