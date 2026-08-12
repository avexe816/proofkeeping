/**
 * セッションのスコープ（表示中の施設）の入出力スキーマ。
 *
 * task: docs/tasks/P0-21.md（P0-14 の propertyId 単独から広げた）
 * 仕様: docs/PK-SPEC-P0.md §23.4
 *
 * ── `"ALL"` を受ける ────────────────────────────────────
 * §23.4 は `propertyId` または `"ALL"`（全社サマリー）を受けると定める。
 * **`"ALL"` を指定できるのは全社ビューを持つロールだけ**で、それ以外は
 * 403（§23.4 MUST / §25.1 の受け入れ基準）。判定は
 * `apps/web/src/lib/property/selection.ts` が行う。
 *
 * ── なぜここだけ 403 なのか ─────────────────────────────
 * PK-IMPL-CONTRACT INV-31 が 404 を求めるのは**権限外の `propertyId`**
 * について。403 が禁じられている理由は「資源の存在を示唆する」ことで、
 * `"ALL"` は資源ではなく**スコープの指定**であり、どの組織にも同じように
 * 存在する。403 を返しても漏れる情報が無い。
 * **この理屈が効くのは `"ALL"` だけ。** 施設 ID の拒否は今までどおり 404。
 */

import { z } from "zod";

/**
 * 施設 ID。**形だけを見る。** テナントに属するかは
 * `assertIdBelongsToTenant()`、到達してよいかは第 1 層と
 * `assertPermission()` が判定する（architecture.md §2）。
 */
export const propertyIdSchema = z.string().min(1).max(128);

/** 全社サマリーを表す予約語。**施設 ID として採番されない値**（`__` を含まない）。 */
export const ALL_PROPERTIES = "ALL" as const;

/** 表示スコープ。施設 1 件か、全社か。 */
export const propertyScopeSchema = z.union([z.literal(ALL_PROPERTIES), propertyIdSchema]);

export type PropertyScopeValue = z.infer<typeof propertyScopeSchema>;

/** `POST /api/v1/auth/switch-property` の入力。 */
export const switchPropertyRequestSchema = z.object({
  propertyId: propertyScopeSchema,
});

export type SwitchPropertyRequest = z.infer<typeof switchPropertyRequestSchema>;

/** 切り替え後の状態。**シャード番号や組織 ID を返さない。** */
export const switchPropertyResponseSchema = z.object({
  propertyId: propertyScopeSchema,
});

export type SwitchPropertyResponse = z.infer<typeof switchPropertyResponseSchema>;

/**
 * 切り替えが拒否された理由。
 *
 * **共通の `API_ERROR_CODES` へ足さない。** あちらへ 403 相当を入れると、
 * 資源の拒否にも使える語彙になる（`packages/contracts/src/error.ts` の注記）。
 * ここに閉じてあるのは、スコープの拒否だけに使う語だと読めるようにするため。
 */
export const SCOPE_ERROR_CODES = ["SCOPE_FORBIDDEN"] as const;

export type ScopeErrorCode = (typeof SCOPE_ERROR_CODES)[number];

export const scopeErrorSchema = z.object({ error: z.enum(SCOPE_ERROR_CODES) });
