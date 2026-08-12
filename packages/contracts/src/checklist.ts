/**
 * チェックリストの定義と実施の API 入出力（PK-SPEC-P1 §6 / W-16）。
 *
 * task: docs/tasks/P1-06.md
 */

import { z } from "zod";

import { checklistValueSchema, resourceIdSchema, taskReasonCodeSchema, taskTypeSchema } from "./task.js";

/**
 * 対応言語（§12.1）。**モバイルは日英、管理画面は日本語のみ。**
 * 多言語対応をプランで制限しない（INV-35）。
 */
export const CHECKLIST_LOCALES = ["ja", "en"] as const;

/**
 * 項目の表示文言。**`ja` を必須にする。**
 *
 * 未翻訳なら日本語を表示し「日本語のみ」と示す（§12.2）ので、
 * 日本語が無い項目は画面に出せない。
 */
export const checklistLabelsSchema = z
  .object({
    ja: z.string().trim().min(1).max(120),
    en: z.string().trim().min(1).max(200).optional(),
  })
  .transform((labels): Record<string, string> =>
    labels.en === undefined ? { ja: labels.ja } : { ja: labels.ja, en: labels.en },
  );

/** テンプレートの 1 項目。 */
export const checklistItemInputSchema = z.object({
  section: z.string().trim().min(1).max(60),
  labels: checklistLabelsSchema,
  isRequired: z.boolean(),
  photoRequired: z.boolean(),
});

export type ChecklistItemInput = z.infer<typeof checklistItemInputSchema>;

/**
 * テンプレートの作成・更新。
 *
 * 項目の上限を 30 にしてある。§7 のリスク表は「チェックリストが長すぎると
 * 形骸化する。16 項目を上限の目安とする」と述べる。**目安を強制しない**
 * （施設ごとに事情がある）が、桁違いの長さは弾く。
 */
export const checklistTemplateUpsertRequestSchema = z.object({
  /** null = 組織共通（§6.1）。 */
  propertyId: resourceIdSchema.nullable(),
  /** null = 全客室タイプ。`propertyId` が null のときは null のみ。 */
  roomTypeId: resourceIdSchema.nullable(),
  taskType: taskTypeSchema,
  name: z.string().trim().min(1).max(80),
  items: z.array(checklistItemInputSchema).min(1).max(30),
});

export type ChecklistTemplateUpsertRequest = z.infer<typeof checklistTemplateUpsertRequestSchema>;

/** テンプレート 1 件の応答。 */
export const checklistTemplateSchema = z.object({
  templateId: z.string(),
  propertyId: z.string().nullable(),
  roomTypeId: z.string().nullable(),
  taskType: taskTypeSchema,
  name: z.string(),
  version: z.number().int().min(1),
  isActive: z.boolean(),
  items: z.array(
    z.object({
      itemId: z.string(),
      section: z.string(),
      labels: z.record(z.string(), z.string()),
      isRequired: z.boolean(),
      photoRequired: z.boolean(),
      sortOrder: z.number().int().min(0),
    }),
  ),
});

export type ChecklistTemplate = z.infer<typeof checklistTemplateSchema>;

/** `GET /api/v1/checklist-templates` の応答。 */
export const checklistTemplateListResponseSchema = z.object({
  data: z.array(checklistTemplateSchema),
});

export type ChecklistTemplateListResponse = z.infer<typeof checklistTemplateListResponseSchema>;

/**
 * 実施結果の記録（M-04）。
 *
 * **1 項目ずつ送る。**「すべてチェック」に相当する一括更新の口を作らない
 * （ui-writing.md §3 / §6.3）。まとめて送れる API があると、画面に
 * ボタンが無くても実質同じことができてしまう。
 */
export const checklistResultUpdateRequestSchema = z.object({
  itemId: resourceIdSchema,
  value: checklistValueSchema,
  /** `COULD_NOT` の理由コード。**説明文は求めない**（INV-24）。 */
  reasonCode: taskReasonCodeSchema.optional(),
  /** 端末側の記録時刻（epoch ミリ秒）。参考値。 */
  clientTs: z.number().int().positive().optional(),
});

export type ChecklistResultUpdateRequest = z.infer<typeof checklistResultUpdateRequestSchema>;

/** タスクのチェックリスト（M-04 の表示に必要な最小限）。 */
export const taskChecklistResponseSchema = z.object({
  taskId: z.string(),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  items: z.array(
    z.object({
      itemId: z.string(),
      section: z.string(),
      labels: z.record(z.string(), z.string()),
      isRequired: z.boolean(),
      photoRequired: z.boolean(),
      value: checklistValueSchema.nullable(),
      reasonCode: z.string().nullable(),
      checkedAt: z.number().int().nullable(),
      photoCount: z.number().int().min(0),
      sortOrder: z.number().int().min(0),
    }),
  ),
});

export type TaskChecklistResponse = z.infer<typeof taskChecklistResponseSchema>;
