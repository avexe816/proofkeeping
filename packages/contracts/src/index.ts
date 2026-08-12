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

// 表示中の施設の切り替え（P0-14）。`"ALL"` を足すのは P0-21。
export {
  propertyIdSchema,
  switchPropertyRequestSchema,
  switchPropertyResponseSchema,
  type SwitchPropertyRequest,
  type SwitchPropertyResponse,
} from "./session.js";

// middleware 共通のエラー応答（P0-10）。**403 を足さないこと**（INV-31）。
export {
  API_ERROR_CODES,
  apiErrorSchema,
  type ApiError,
  type ApiErrorCode,
} from "./error.js";
