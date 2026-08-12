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

// middleware 共通のエラー応答（P0-10）。**403 を足さないこと**（INV-31）。
export {
  API_ERROR_CODES,
  apiErrorSchema,
  type ApiError,
  type ApiErrorCode,
} from "./error.js";
