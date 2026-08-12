/**
 * 組織設定の API 入出力（PK-SPEC-P1 §19.4）。
 *
 * task: docs/tasks/P1-22.md
 *
 * ── ここに置いてあるのは 1 項目だけ ─────────────────────
 * 組織設定の画面（W-10 相当）は P1 のどの task にも無い。**その画面を
 * 作る task が、必要な項目をこのファイルへ足すこと。**
 * 名称・タイムゾーン・既定言語は `organization` 表にあるが、
 * 変更する経路が無いのでスキーマにも載せていない
 * （受け取れる形だけ先に作ると、検証も監査も無いまま口が開く）。
 *
 * ── `organizationId` を受け取らない ─────────────────────
 * どの組織かは常にセッションから解決する（CLAUDE.md §4）。
 */

import { z } from "zod";

/**
 * 施設選択画面を挟む担当施設数（§19.4）。
 *
 * **既定 4・範囲 2〜10。** 既定値は DB 側の `default(4)` が持ち、
 * ここは受け付ける範囲だけを持つ（同じ数を 2 か所に書かない）。
 */
export const PROPERTY_SELECTION_THRESHOLD = { min: 2, max: 10 } as const;

export const propertySelectionThresholdSchema = z
  .number()
  .int()
  .min(PROPERTY_SELECTION_THRESHOLD.min)
  .max(PROPERTY_SELECTION_THRESHOLD.max);

/**
 * `PATCH /api/v1/organization/settings`。
 *
 * **項目ごとに省略できる形にしない。** 1 項目しか無い今は差が出ないが、
 * 省略可能な項目が並ぶと「送らなかった」と「空にした」の区別が
 * 呼び出し側の書き方に依存する。項目が増えるときは全項目を必須にするか、
 * 用途ごとに経路を分けること。
 */
export const organizationSettingsUpdateSchema = z.object({
  propertySelectionThreshold: propertySelectionThresholdSchema,
});

export type OrganizationSettingsUpdate = z.infer<typeof organizationSettingsUpdateSchema>;

/** `GET /api/v1/organization/settings` の応答。 */
export const organizationSettingsResponseSchema = z.object({
  data: z.object({
    propertySelectionThreshold: propertySelectionThresholdSchema,
  }),
});

export type OrganizationSettingsResponse = z.infer<typeof organizationSettingsResponseSchema>;
