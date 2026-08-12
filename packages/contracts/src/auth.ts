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
// PIN（現場系 — CLEANER / INSPECTOR）
// ────────────────────────────────────────────────────────────

/** security.md §2 の PIN ポリシー。UI の説明文もこの値を使うこと。 */
export const PIN_POLICY = {
  length: 4,
} as const;

/** 4 桁の数字。**形だけ。** 連番・ゾロ目の判定は `pinSchema` が足す。 */
const pinDigitsSchema = z.string().regex(/^[0-9]{4}$/);

/**
 * 桁を数値の配列にする。
 *
 * **スプレッドや `.split("")` を使わない。** ここへ来る値は
 * `pinDigitsSchema` を通った ASCII 数字 4 桁だけだが、文字列の分解は
 * サロゲートペアの扱いで壊れうる書き方なので、添字で読む形に寄せる
 * （ESLint `@typescript-eslint/no-misused-spread`）。
 */
function toDigits(pin: string): number[] {
  const digits: number[] = [];
  for (let i = 0; i < pin.length; i++) digits.push(pin.charCodeAt(i) - 0x30);
  return digits;
}

/** ゾロ目（0000 / 1111 …）。 */
function isRepeatedDigits(pin: string): boolean {
  const digits = toDigits(pin);
  return digits.every((n) => n === digits[0]);
}

/**
 * 連番（1234 / 4321 / 0123 / 9876 …）。昇順・降順の両方を弾く。
 *
 * **巡回（9012 や 3210 の 0→9 跨ぎ）は連番として扱わない。** 現場で口頭伝達される
 * 値なので、拒否の理由が説明できる範囲に留める。ここを広げるほど
 * 「なぜこの PIN が登録できないのか」が現場で伝わらなくなる。
 */
function isSequentialDigits(pin: string): boolean {
  const digits = toDigits(pin);
  const ascending = digits.every((n, i) => i === 0 || n === (digits[i - 1] ?? 0) + 1);
  const descending = digits.every((n, i) => i === 0 || n === (digits[i - 1] ?? 0) - 1);
  return ascending || descending;
}

/**
 * **登録時**の PIN。連番・ゾロ目を拒否する（security.md §2）。
 *
 * ログインの検証には使わない（`pinLoginRequestSchema` の注記を読むこと）。
 *
 * ── 拒否の理由を細分化しない ────────────────────────────
 * 「連番だから」「ゾロ目だから」を分けても、利用者は次に何を入れればよいか
 * 分からない。UI は「続き番号・同じ数字の繰り返しは使えません」の 1 文で足りる。
 */
export const pinSchema = pinDigitsSchema
  .refine((pin) => !isRepeatedDigits(pin))
  .refine((pin) => !isSequentialDigits(pin));

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
 * PIN ログインの入力（P0-09）。
 *
 * ── ここに `pinSchema` を使わない ───────────────────────
 * ポリシー（連番・ゾロ目の拒否）を**ログインに掛けない。** 掛けると
 *   1. ポリシー追加前に登録された PIN でログインできなくなる
 *   2. 400（形が違う）と 401（認証失敗）の差から、その PIN が
 *      ポリシー違反の値かどうかが読める
 * が起きる。**ポリシーは登録時（`pinSchema`）にだけ掛ける。**
 * パスワード側と同じ理由（このファイル冒頭の注記）。
 */
export const pinLoginRequestSchema = z.object({
  orgShortId: orgShortIdSchema,
  staffNumber: staffNumberSchema,
  /** 形だけ検査する。理由は直上の注記。 */
  pin: pinDigitsSchema,
});

export type PinLoginRequest = z.infer<typeof pinLoginRequestSchema>;

/**
 * PIN ログイン成功時の本体。
 *
 * `loginResponseSchema` と分けてあるのは `pinMustChange` のため。
 * **セッション ID を含めない**のは共通（Cookie だけで運ぶ）。
 */
export const pinLoginResponseSchema = z.object({
  /** セッションの絶対期限（ISO 8601）。現場系は 16 時間 = 1 勤務。 */
  expiresAt: z.string(),
  /**
   * 初回変更の強制（security.md §2）。
   *
   * **P0-09 の時点でこのフラグを強制する画面が無い。** PIN 変更は P1 の担当で、
   * ここでは「変更が要る状態か」を返すところまで。true を無視しても
   * 業務は通ってしまう。docs/PROGRESS.md の申し送りを参照。
   */
  pinMustChange: z.boolean(),
});

export type PinLoginResponse = z.infer<typeof pinLoginResponseSchema>;

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
