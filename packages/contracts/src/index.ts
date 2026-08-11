// API 入出力の Zod スキーマ（唯一の型定義）。実体は各 API task で追加する。

// 認証（P0-08）。ログイン識別子は orgShortId + スタッフ番号 + 認証情報。
export {
  AUTH_ERROR_CODES,
  ORG_SHORT_ID_LENGTH,
  PASSWORD_POLICY,
  authErrorSchema,
  loginRequestSchema,
  loginResponseSchema,
  orgShortIdSchema,
  passwordSchema,
  staffNumberSchema,
  type AuthError,
  type AuthErrorCode,
  type LoginRequest,
  type LoginResponse,
} from "./auth.js";
