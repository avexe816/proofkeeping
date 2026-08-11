/**
 * 認証 API の入出力スキーマ。
 *
 * task:  docs/tasks/P0-08.md
 * ルール: .claude/rules/security.md §2
 * 決定:  docs/DECISIONS.md #018（ログイン識別子）/ #019（ハッシュ方式）
 *
 * ── ログイン識別子は 3 フィールド ───────────────────────
 * `orgShortId`（組織）+ `staffNumber`（組織内の個人）+ 認証情報。
 * **メールアドレスは識別子に使わない。** `user` が組織スコープの表で、
 * メールの一意性が組織内に閉じているため、メールから組織を解決できない。
 *
 * ── ログイン時にパスワードポリシーを掛けない ────────────
 * `loginRequestSchema` の `password` は「空でない文字列」までしか見ない。
 * ここでポリシー（10 文字以上・英大小数字）を検査すると、
 *   1. ポリシー変更前に作られた既存パスワードでログインできなくなる
 *   2. 400 と 401 の差からパスワードの形が推測できる
 * の 2 つが起きる。**ポリシーは設定時（`passwordSchema`）にだけ掛ける。**
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────
// 識別子
// ────────────────────────────────────────────────────────────

/** `orgShortId` の桁数。`packages/db/src/id.ts` の `ORG_SHORT_ID_LENGTH` と同じ。 */
export const ORG_SHORT_ID_LENGTH = 6;

/**
 * 組織の 6 桁。
 *
 * **採番に使う 31 文字（`ORG_SHORT_ID_ALPHABET`）より緩い `[a-z0-9]` で受ける。**
 * ここを 31 文字に狭めても得るものが無い。存在しない 6 桁は
 * `org_directory` の引き当てに失敗して同じ `AUTH_FAILED` になるだけで、
 * 二重管理した文字集合がずれる危険の方が大きい。
 *
 * 大文字で入力されうる（口頭・印刷物からの転記）ので小文字へ寄せる。
 */
export const orgShortIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .length(ORG_SHORT_ID_LENGTH)
  .regex(/^[a-z0-9]+$/);

/**
 * スタッフ番号。組織内で一意（`uq_user_org_staff_number`）。
 *
 * **大文字小文字を変換しない。** DB の UNIQUE 制約が case-sensitive なので、
 * ここで寄せると別人の行に当たりうる。前後の空白だけ落とす。
 */
export const staffNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

// ────────────────────────────────────────────────────────────
// パスワード
// ────────────────────────────────────────────────────────────

/** security.md §2 のパスワードポリシー。UI の説明文もこの値を使うこと。 */
export const PASSWORD_POLICY = {
  minLength: 10,
  /** 上限は運用上の安全弁。PBKDF2 の計算量は入力長で変わらない。 */
  maxLength: 256,
  requiresUpperCase: true,
  requiresLowerCase: true,
  requiresDigit: true,
} as const;

/** **設定時**のパスワード。ログインの検証には使わない（冒頭の注記を読むこと）。 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_POLICY.minLength)
  .max(PASSWORD_POLICY.maxLength)
  .regex(/[A-Z]/)
  .regex(/[a-z]/)
  .regex(/[0-9]/);

// ────────────────────────────────────────────────────────────
// ログイン
// ────────────────────────────────────────────────────────────

export const loginRequestSchema = z.object({
  orgShortId: orgShortIdSchema,
  staffNumber: staffNumberSchema,
  /** 形を検査しない。理由は冒頭の注記。 */
  password: z.string().min(1).max(PASSWORD_POLICY.maxLength),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * ログイン成功時の本体。
 *
 * **セッション ID を含めない。** Cookie（`pk_session`）だけで運ぶ。
 * 本体に入れると JS から読める場所へ複製され、`httpOnly` の意味が消える。
 * 表示名やロールもここでは返さない。P0-10 の `/me` 相当が担う。
 */
export const loginResponseSchema = z.object({
  /** セッションの絶対期限（ISO 8601）。クライアントは再ログインの案内に使う。 */
  expiresAt: z.string(),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * 認証エラーのコード。
 *
 * **`AUTH_FAILED` を細分化しないこと**（security.md §2）。
 * 識別子が存在しない / パスワード相違 / ロック中 / 無効化済みは
 * すべてこれ 1 つで返す。区別できるとアカウントの存在が推測できる。
 */
export const AUTH_ERROR_CODES = ["INVALID_REQUEST", "AUTH_FAILED", "RATE_LIMITED"] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const authErrorSchema = z.object({
  error: z.enum(AUTH_ERROR_CODES),
});

export type AuthError = z.infer<typeof authErrorSchema>;
