// API 入出力の Zod スキーマ（唯一の型定義）。実体は各 API task で追加する。

// 認証（P0-08 パスワード / P0-09 PIN）。
// ログイン識別子は orgShortId + スタッフ番号 + 認証情報。
export {
  AUTH_ERROR_CODES,
  ORG_SHORT_ID_LENGTH,
  PASSWORD_POLICY,
  PIN_POLICY,
  authErrorSchema,
  loginRequestSchema,
  loginResponseSchema,
  orgShortIdSchema,
  passwordSchema,
  pinLoginRequestSchema,
  pinLoginResponseSchema,
  pinSchema,
  staffNumberSchema,
  type AuthError,
  type AuthErrorCode,
  type LoginRequest,
  type LoginResponse,
  type PinLoginRequest,
  type PinLoginResponse,
} from "./auth.js";

// 表示中の施設の切り替え（P0-14 / P0-21 で `"ALL"` を追加）。
export {
  ALL_PROPERTIES,
  SCOPE_ERROR_CODES,
  propertyIdSchema,
  propertyScopeSchema,
  scopeErrorSchema,
  switchPropertyRequestSchema,
  switchPropertyResponseSchema,
  type PropertyScopeValue,
  type ScopeErrorCode,
  type SwitchPropertyRequest,
  type SwitchPropertyResponse,
} from "./session.js";

// 施設サマリー（P0-21）。rollup テーブルからのみ組み立てる（§26 の絶対ルール）。
export {
  SEAL_IMAGE,
  TAX_ROUNDING_MODES,
  businessDateSchema,
  invoiceRegistrationNumberSchema,
  propertySummaryResponseSchema,
  propertySummarySchema,
  taxProfileUpdateSchema,
  type PropertySummary,
  type PropertySummaryResponse,
  type TaxProfileUpdate,
} from "./property.js";

// 清掃タスク（P1-02 〜 P1-05）。enum の語彙は PK-SPEC-P1 §2.1 を正とする。
export {
  CHECKLIST_VALUES,
  TASK_ACTIONS,
  TASK_ERROR_CODES,
  TASK_REASON_CODES,
  TASK_STATUSES,
  TASK_TYPES,
  checklistValueSchema,
  resourceIdSchema,
  roomPlanAllCheckoutRequestSchema,
  roomPlanEntrySchema,
  roomPlanImportRequestSchema,
  roomPlanUpsertRequestSchema,
  roomPlanUpsertResponseSchema,
  standardTimeEntrySchema,
  standardTimeListResponseSchema,
  standardTimeUpsertRequestSchema,
  taskActionSchema,
  taskErrorSchema,
  taskGenerateRequestSchema,
  taskGenerateResponseSchema,
  taskListResponseSchema,
  taskReasonCodeSchema,
  taskStatusSchema,
  taskSummarySchema,
  taskTransitionRequestSchema,
  taskTransitionResponseSchema,
  taskTypeSchema,
  type RoomPlanAllCheckoutRequest,
  type RoomPlanEntry,
  type RoomPlanImportRequest,
  type RoomPlanUpsertRequest,
  type RoomPlanUpsertResponse,
  type StandardTimeEntry,
  type StandardTimeListResponse,
  type StandardTimeUpsertRequest,
  type TaskActionValue,
  type TaskError,
  type TaskErrorCode,
  type TaskGenerateRequest,
  type TaskGenerateResponse,
  type TaskListResponse,
  type TaskSummary,
  type TaskTransitionRequest,
  type TaskTransitionResponse,
  type TaskTypeValue,
} from "./task.js";

// 清掃写真（P1-11）。位置情報の受け口を作らない（INV-11）。
export {
  ACCEPTED_PHOTO_MIME,
  MAX_PHOTOS_PER_TASK,
  MAX_PHOTO_BYTES,
  PHOTO_ERROR_CODES,
  PHOTO_JPEG_QUALITY,
  PHOTO_KINDS,
  PHOTO_MAX_LONG_EDGE,
  photoErrorSchema,
  photoKindSchema,
  photoUploadMetaSchema,
  taskPhotoListResponseSchema,
  taskPhotoSchema,
  taskPhotoUploadResponseSchema,
  type AcceptedPhotoMime,
  type PhotoError,
  type PhotoErrorCode,
  type PhotoKindValue,
  type PhotoUploadMeta,
  type TaskPhoto,
  type TaskPhotoListResponse,
  type TaskPhotoUploadResponse,
} from "./photo.js";

// チェックリスト（P1-06）。実施結果は 3 値（INV-22）。
export {
  CHECKLIST_LOCALES,
  checklistItemInputSchema,
  checklistLabelsSchema,
  checklistResultUpdateRequestSchema,
  checklistTemplateListResponseSchema,
  checklistTemplateSchema,
  checklistTemplateUpsertRequestSchema,
  taskChecklistResponseSchema,
  type ChecklistItemInput,
  type ChecklistResultUpdateRequest,
  type ChecklistTemplate,
  type ChecklistTemplateListResponse,
  type ChecklistTemplateUpsertRequest,
  type TaskChecklistResponse,
} from "./checklist.js";

// middleware 共通のエラー応答（P0-10）。**403 を足さないこと**（INV-31）。
export {
  API_ERROR_CODES,
  apiErrorSchema,
  type ApiError,
  type ApiErrorCode,
} from "./error.js";
