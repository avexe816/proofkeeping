/**
 * プラットフォーム運営の API 契約（PF-16 の初期開通）。
 *
 * task: docs/tasks/PF-16.md
 * 決定: docs/DECISIONS.md #240・#245
 *
 * ── 応答に秘密を持たせない ──────────────────────────────
 * 開通 token は**応答に含めない。** 受け取るのは workflow の runner で、
 * 応答は GitHub Actions のログに出うる。渡すのはメール 1 通だけ
 * （`lib/platform/bootstrapMail.ts` の注記）。
 *
 * ── パスワードをここで受け取らない ──────────────────────
 * 開通の要求にパスワードの欄を作らない。**既定パスワードを作らない**
 * （#240 の 3）は「誰かが代わりに決められる欄が無い」ことで満たす。
 */

import { z } from "zod";

/**
 * 初期開通の要求。**メールアドレスと表示名だけ。**
 *
 * メールはログイン識別子（`platform_operator.email` / security.md §2 の
 * 例外 — 運営担当者はどの組織にも属さず、3 フィールドでは解決できない）。
 */
export const platformBootstrapRequestSchema = z.object({
  email: z.email().trim().max(254),
  displayName: z.string().trim().min(1).max(60),
});
export type PlatformBootstrapRequest = z.infer<typeof platformBootstrapRequestSchema>;

/** 断った理由。**利用者向けではなく、押した人が次の一手を選ぶための値。** */
export const PLATFORM_BOOTSTRAP_ERROR_CODES = [
  /** 運営担当者が既に居る（**2 人目以降は PF-14 の招待**）。 */
  "OPERATOR_EXISTS",
  /**
   * 開通リンクを渡せなかった。
   *
   * **経路が無いのか送れなかったのかを応答で分けない**（人間のレビュー
   * 指摘 2026-08-21 / #246）。この口は無認証で公開されており、分けると
   * 「この環境はメール送信が未設定」という内部の状態を、鍵を持たない
   * 探索者にまで教えることになる。内訳は `platform_audit_log` の
   * `detail.cause` にだけ残す。
   */
  "DELIVERY_REJECTED",
  /** 入力が契約に合わない。 */
  "INVALID_REQUEST",
] as const;
export type PlatformBootstrapErrorCode = (typeof PLATFORM_BOOTSTRAP_ERROR_CODES)[number];

/**
 * 初期開通の応答。**`expiresAt` までしか返さない。**
 *
 * 「送った」ことと「いつ切れるか」だけが分かればよい。宛先も token も
 * 返さない（宛先は要求した本人が知っている / security.md §3）。
 */
export const platformBootstrapResponseSchema = z.object({
  ok: z.literal(true),
  expiresAt: z.string(),
});
export type PlatformBootstrapResponse = z.infer<typeof platformBootstrapResponseSchema>;

export const platformBootstrapErrorSchema = z.object({
  error: z.enum(PLATFORM_BOOTSTRAP_ERROR_CODES),
});
export type PlatformBootstrapError = z.infer<typeof platformBootstrapErrorSchema>;
