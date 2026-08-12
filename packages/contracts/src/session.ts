/**
 * セッションのスコープ（表示中の施設）の入出力スキーマ。
 *
 * task: docs/tasks/P0-14.md
 * 仕様: docs/PK-SPEC-P0.md §23.4
 *
 * ── `"ALL"` はまだ受け付けない ──────────────────────────
 * §23.4 は `propertyId` または `"ALL"`（全社サマリー）を受けると定めるが、
 * **`"ALL"` を実装するのは P0-21。** 全社ビューを持つロールの判定
 * （`OWNER` / `ORG_ADMIN` / `AUDITOR` / `VENDOR_ADMIN` は可、
 * `PROPERTY_MANAGER` 以下は 403）と、それを見せる画面が要る。
 * **受け口だけ先に開けない。** 開けると、判定の無いまま `"ALL"` が
 * セッションに入り、権限の無いロールに全社の表示が残る。
 *
 * P0-21 はこのスキーマを `z.union([...])` へ広げること。
 * `switchPropertyRequestSchema` の名前は据え置ける。
 */

import { z } from "zod";

/**
 * 施設 ID。**形だけを見る。** テナントに属するかは
 * `assertIdBelongsToTenant()`、到達してよいかは第 1 層と
 * `assertPermission()` が判定する（architecture.md §2）。
 */
export const propertyIdSchema = z.string().min(1).max(128);

/** `POST /api/v1/auth/switch-property` の入力。 */
export const switchPropertyRequestSchema = z.object({
  propertyId: propertyIdSchema,
});

export type SwitchPropertyRequest = z.infer<typeof switchPropertyRequestSchema>;

/** 切り替え後の状態。**シャード番号や組織 ID を返さない。** */
export const switchPropertyResponseSchema = z.object({
  propertyId: propertyIdSchema,
});

export type SwitchPropertyResponse = z.infer<typeof switchPropertyResponseSchema>;
