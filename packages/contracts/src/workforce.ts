/**
 * Workforce の入出力（P8-01 / P8-02 / PK-SPEC-P8 §1.3・§1.4）。
 *
 * ルール: .claude/rules/security.md §3（保存してはいけないデータ）
 * 契約: docs/PK-IMPL-CONTRACT.md INV-08
 *
 * ── 受け取らない項目 ────────────────────────────────────
 * 本籍・住所・生年月日・マイナンバー・口座情報・在留カード番号・
 * パスポート番号。**表に列が無いだけでなく、入口でも受け取らない。**
 * スキーマに項目を足そうとしたら、まず security.md §3 に照らすこと。
 *
 * ── 就労可否を受け取らない ──────────────────────────────
 * 仕様 §1.4 MUST「在留資格の種類から就労可否を自動判定しない」。
 * `canWork` のような項目を足さない。**期限だけを扱う。**
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

/** 就業の状態（P8-01）。`packages/db` の `WORK_STATUSES` と同じ語彙。 */
export const WORK_STATUS_VALUES = ["ACTIVE", "TRAINING", "ON_LEAVE", "RESIGNED"] as const;

export const workStatusSchema = z.enum(WORK_STATUS_VALUES);

export type WorkStatusValue = (typeof WORK_STATUS_VALUES)[number];

/** 在留資格の種別（§1.4）。**表示のためだけの区分。** */
export const RESIDENCY_STATUS_TYPE_VALUES = [
  "SPECIFIED_SKILLED_1",
  "SPECIFIED_SKILLED_2",
  "TRAINING_EMPLOYMENT",
  "PERMANENT",
  "SPOUSE",
  "STUDENT_PART_TIME",
  "OTHER",
  "NOT_APPLICABLE",
] as const;

export const residencyStatusTypeSchema = z.enum(RESIDENCY_STATUS_TYPE_VALUES);

export type ResidencyStatusTypeValue = (typeof RESIDENCY_STATUS_TYPE_VALUES)[number];

/**
 * 在留資格の登録・更新（§1.4）。
 *
 * `expiresOn` は `NOT_APPLICABLE`（日本国籍など）では `null`。
 * **`null` を許すが、種別が期限を要するのに `null` のときは弾く**
 * （下の `superRefine`）。空欄のまま保存できると、期限アラートが
 * 静かに対象から外れる。
 */
export const residencyUpsertRequestSchema = z
  .object({
    staffProfileId: resourceIdSchema,
    statusType: residencyStatusTypeSchema,
    /** 制度の名称が変わっても表を作り直さずに済むようにする任意ラベル。 */
    statusLabel: z.string().max(64).nullish(),
    expiresOn: businessDateSchema.nullish(),
    renewalAppliedOn: businessDateSchema.nullish(),
    workPermitRequired: z.boolean().default(false),
    /** 留学生等の週あたり上限時間。0〜168。 */
    weeklyHourLimit: z.number().int().min(0).max(168).nullish(),
    note: z.string().max(500).nullish(),
  })
  .superRefine((value, ctx) => {
    // 期限を持たないのは「日本国籍・永住者など」だけ。
    // **在留期間のある資格で空欄を通さない。**
    const needsExpiry =
      value.statusType !== "NOT_APPLICABLE" && value.statusType !== "PERMANENT";
    if (needsExpiry && (value.expiresOn === null || value.expiresOn === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresOn"],
        message: "EXPIRES_ON_REQUIRED",
      });
    }
    // 申請日が期限より後なのは入力の誤り（更新は期限前に出す）。
    if (
      value.renewalAppliedOn !== null &&
      value.renewalAppliedOn !== undefined &&
      value.expiresOn !== null &&
      value.expiresOn !== undefined &&
      value.renewalAppliedOn > value.expiresOn
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["renewalAppliedOn"],
        message: "RENEWAL_AFTER_EXPIRY",
      });
    }
  });

export type ResidencyUpsertRequest = z.infer<typeof residencyUpsertRequestSchema>;

/** スタッフ台帳の更新（P8-01）。**渡した項目だけを書き換える。** */
export const staffLedgerUpdateRequestSchema = z.object({
  membershipId: resourceIdSchema,
  hiredOn: businessDateSchema.nullish(),
  resignedOn: businessDateSchema.nullish(),
  workStatus: workStatusSchema.optional(),
  /** 対応できる言語。**表示言語（`user.locale`）とは別物。** */
  languages: z.array(z.string().min(2).max(8)).max(10).optional(),
  skills: z.array(z.string().min(2).max(32)).max(20).optional(),
  note: z.string().max(500).nullish(),
});

export type StaffLedgerUpdateRequest = z.infer<typeof staffLedgerUpdateRequestSchema>;

/** シフトの区分（P8-03）。`packages/db` の `SHIFT_TYPES` と同じ語彙。 */
export const SHIFT_TYPE_VALUES = ["WORK", "OFF", "PAID_LEAVE", "SICK", "TRAINING"] as const;

export const shiftTypeSchema = z.enum(SHIFT_TYPE_VALUES);

export type ShiftTypeValue = (typeof SHIFT_TYPE_VALUES)[number];

/** `"09:00"` 形式。**打刻ではなく予定**（DECISIONS #221）。 */
export const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * シフトの登録・上書き（P8-03 / PK-SPEC-P8 §1.5）。1 スタッフ × 1 業務日。
 *
 * **`WORK` だけが施設を持つ。** 休み・研修に施設が付いていたら弾き、
 * `WORK` に施設が無くても弾く（下の `superRefine`）。どちらの取り違えも
 * 「その施設の出勤者数」を静かに狂わせる。
 */
export const shiftUpsertRequestSchema = z
  .object({
    membershipId: resourceIdSchema,
    businessDate: businessDateSchema,
    shiftType: shiftTypeSchema,
    propertyId: resourceIdSchema.nullish(),
    startAt: clockSchema.nullish(),
    endAt: clockSchema.nullish(),
    /** 分。既定 60（仕様 §1.5）。 */
    breakMinutes: z.number().int().min(0).max(480).default(60),
    note: z.string().max(200).nullish(),
  })
  .superRefine((value, ctx) => {
    const hasProperty = value.propertyId !== null && value.propertyId !== undefined;
    if (value.shiftType === "WORK" && !hasProperty) {
      ctx.addIssue({ code: "custom", path: ["propertyId"], message: "PROPERTY_REQUIRED" });
    }
    if (value.shiftType !== "WORK" && hasProperty) {
      ctx.addIssue({ code: "custom", path: ["propertyId"], message: "PROPERTY_NOT_ALLOWED" });
    }
  });

export type ShiftUpsertRequest = z.infer<typeof shiftUpsertRequestSchema>;
