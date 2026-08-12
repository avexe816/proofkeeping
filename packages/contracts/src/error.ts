/**
 * API 共通のエラー応答。
 *
 * task:  docs/tasks/P0-10.md
 * ルール: .claude/rules/security.md §1 / .claude/rules/architecture.md §1・§2
 * 決定:  docs/DECISIONS.md #022（拒否は一律 404）
 *
 * 認証 API 固有のコード（`AUTH_FAILED` / `RATE_LIMITED`）は `auth.ts` にある。
 * こちらは middleware が返す、どの API にも共通のものだけを持つ。
 *
 * ── 403 を作らない ──────────────────────────────────────
 * 権限が無い・担当外施設・別テナントの ID は**すべて `RESOURCE_NOT_FOUND`（404）。**
 * 403 は「その資源は在るが見せない」と読めるため、存在を示唆する
 * （architecture.md §2 第2層 / PK-IMPL-CONTRACT INV-31）。
 * **このコード表に 403 相当を足さないこと。**
 *
 * ── 401 と 404 を混ぜない ───────────────────────────────
 * `UNAUTHENTICATED` は「誰であるかが確定していない」状態で、資源の有無を
 * 何も語らない。ここを 404 に寄せると、セッション切れと権限外の区別がつかず、
 * 現場が「入り直せばよい」のか「そもそも見られない」のかを判断できなくなる。
 * 逆に権限判定の失敗を 401 に寄せるのも誤り（ログインし直せば見えると読める）。
 *
 * ── 402 は 403 の言い換えではない ───────────────────────
 * `PAYMENT_REQUIRED` は「契約していないモジュール」だけに使う（P0-12）。
 * 権限が無いことを 402 で表さないこと。**判定は権限（404）が先、契約（402）が後。**
 * 逆にすると担当外施設に「契約していない」と答えてしまい、
 * 402 が施設の存在を示唆する経路になる（`packages/db/src/errors.ts`）。
 *
 * ── `INTERNAL_ERROR` に内訳を持たせない ─────────────────
 * `SHARD_BINDING_MISSING:SHARD_07` のような例外はシャード番号を含む。
 * これを応答へ載せない（architecture.md §1「シャード番号を URL・レスポンス・
 * ログに露出しない」）。無害化は `middleware/resourceGuard.ts` が行う。
 */

import { z } from "zod";

/**
 * middleware が返すエラーコード。
 *
 * | コード | HTTP | 意味 |
 * |---|---|---|
 * | `UNAUTHENTICATED` | 401 | セッションが無い・期限切れ・所属が無効 |
 * | `PAYMENT_REQUIRED` | 402 | モジュールを契約していない（P0-12） |
 * | `RESOURCE_NOT_FOUND` | 404 | 資源が無い / 権限が無い / 担当外施設 / 別テナントの ID |
 * | `INTERNAL_ERROR` | 500 | 上記以外。内訳を外へ出さない |
 */
export const API_ERROR_CODES = [
  "UNAUTHENTICATED",
  "PAYMENT_REQUIRED",
  "RESOURCE_NOT_FOUND",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.enum(API_ERROR_CODES),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
