/**
 * API キー作成の入力（PK-SPEC-P6 §6.1・§6.2 / P6-12）。
 *
 * task:  docs/tasks/P6-12.md
 * ルール: .claude/rules/security.md §7
 *
 * ── 平文を受け取らない ──────────────────────────────────
 * トークンはサーバーが採番する（`lib/auth/apiKey.ts`）。
 * **利用者に決めさせる欄を作らない。** 決めさせると、推測しやすい
 * 値が使われうるうえ、平文が入力ログに残る経路ができる。
 *
 * ── `propertyIds` の `null` と `[]` ─────────────────────
 * `null` = 組織全体。配列 = その施設だけ。`[]` = 1 件も見えない。
 * **3 つを区別する**（DECISIONS #017）。`.nullable()` を外さないこと。
 */

import { z } from "zod";

/** 公開 API のスコープ（§6.2）。`packages/db` の `API_SCOPES` と同じ並び。 */
export const API_SCOPE_CODES = [
  "occupancy:write",
  "signals:write",
  "tasks:read",
  "findings:read",
  "reports:read",
  "invoices:read",
  "webhooks:manage",
] as const;

export const apiScopeSchema = z.enum(API_SCOPE_CODES);

export type ApiScopeCode = (typeof API_SCOPE_CODES)[number];

/** キーの名前の長さ。**用途が分かる程度で足りる。** */
export const MAX_API_KEY_NAME_LENGTH = 80;

/**
 * 作成の入力。
 *
 * **スコープは 1 つ以上必須。** 空のキーを作れると「何もできないが
 * 認証は通る」鍵が増え、棚卸しの邪魔になる。
 */
export const apiKeyCreateRequestSchema = z.object({
  name: z.string().min(1).max(MAX_API_KEY_NAME_LENGTH),
  scopes: z.array(apiScopeSchema).min(1),
  /** `null` = 組織全体。**`[]` と区別する。** */
  propertyIds: z.array(z.string().min(1)).nullable(),
  /** ISO 8601。`null` は無期限。 */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequestSchema>;
