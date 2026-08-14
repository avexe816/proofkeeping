/**
 * 差異レポート API の入出力（PK-SPEC-P4 §6.1〜§6.3）。
 *
 * task: docs/tasks/P4-06.md / docs/tasks/P4-07.md
 *
 * ```
 * GET   /api/v1/findings           W-06 一覧（§6.1）
 * GET   /api/v1/findings/:id       W-07 詳細（§6.2）
 * PATCH /api/v1/findings/:id/status 状態の変更（§6.3）
 * ```
 *
 * ── 差異は不正の認定ではない ────────────────────────────
 * §1.1 / ui-writing.md §2。語彙に「不正」「検知」「監視」「疑わしい」を
 * 出さない。`CONFIRMED_DISCREPANCY` を選んでも、システムは「差異を確認した」
 * としか言わない（§6.3 MUST）。
 *
 * ── 差異を作る口・消す口が無い ──────────────────────────
 * 差異は照合の結果としてのみ生まれる（`POST /reconciliation/runs`）。
 * ここに `POST /findings` も `DELETE` も置かない。人が触れるのは
 * **状態と理由だけ。**
 *
 * ── 3 系統は必ず 3 つ返す ───────────────────────────────
 * §6.2 MUST。`sources` は 3 つの鍵を常に持ち、欠けている系統は `null`。
 * **鍵ごと省略しないこと。** 省略すると画面が「データなし」を出す根拠を
 * 失い、欠落が黙って消える（§1.2）。
 */

import { z } from "zod";

import { businessDateSchema, resourceIdSchema } from "./task.js";

// ────────────────────────────────────────────────────────────
// 語彙（§2.5 / §3.1）
// ────────────────────────────────────────────────────────────

/** API のエラーコード。**文言を載せない**（画面が i18n キーへ写す）。 */
export const FINDING_ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "INVALID_TRANSITION",
] as const;

export type FindingErrorCode = (typeof FINDING_ERROR_CODES)[number];

export const findingErrorSchema = z.object({ error: z.enum(FINDING_ERROR_CODES) });

export type FindingError = z.infer<typeof findingErrorSchema>;

/** 重要度。`packages/db` の `FINDING_SEVERITIES` と同じ並び。 */
export const FINDING_SEVERITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export const findingSeveritySchema = z.enum(FINDING_SEVERITIES);

export type FindingSeverityValue = (typeof FINDING_SEVERITIES)[number];

/** 状態。`packages/db` の `FINDING_STATUSES` と同じ並び。 */
export const FINDING_STATUSES = [
  "OPEN",
  "REVIEWING",
  "RESOLVED",
  "FALSE_POSITIVE",
  "SUPPRESSED",
] as const;

export const findingStatusSchema = z.enum(FINDING_STATUSES);

export type FindingStatusValue = (typeof FINDING_STATUSES)[number];

/**
 * 人が付けられる状態。
 *
 * **`SUPPRESSED` を含めない。** 抑制は照合が §4.1 の条件で行うもので、
 * 手で「抑制済み」にする操作ではない。手で伏せられる形にすると、
 * §4.3 の「抑制した件数を可視化する」が意味を失う。
 */
export const FINDING_ASSIGNABLE_STATUSES = [
  "OPEN",
  "REVIEWING",
  "RESOLVED",
  "FALSE_POSITIVE",
] as const;

export const findingAssignableStatusSchema = z.enum(FINDING_ASSIGNABLE_STATUSES);

export type FindingAssignableStatusValue = (typeof FINDING_ASSIGNABLE_STATUSES)[number];

/** 解決コード（§6.3 の `RESOLVED` 側）。 */
export const FINDING_RESOLVED_CODES = [
  "OPERATIONAL_EXCEPTION",
  "RECORD_MISSING",
  "SYSTEM_DELAY",
  "EQUIPMENT_ISSUE",
  "PROCESS_IMPROVED",
  "CONFIRMED_DISCREPANCY",
  "OTHER",
] as const;

export type FindingResolvedCodeValue = (typeof FINDING_RESOLVED_CODES)[number];

/** 解決コード（§6.3 の `FALSE_POSITIVE` 側）。 */
export const FINDING_FALSE_POSITIVE_CODES = [
  "RULE_TOO_SENSITIVE",
  "BASELINE_INACCURATE",
  "DATA_ERROR",
  "OTHER",
] as const;

export type FindingFalsePositiveCodeValue = (typeof FINDING_FALSE_POSITIVE_CODES)[number];

/** 両方をまとめた語彙。DB の `resolutionCode` は text なのでここが唯一の門番。 */
export const FINDING_RESOLUTION_CODES = [
  ...FINDING_RESOLVED_CODES,
  ...FINDING_FALSE_POSITIVE_CODES,
] as const;

export type FindingResolutionCodeValue = (typeof FINDING_RESOLUTION_CODES)[number];

/** 理由の長さ。**`OTHER` のときは必須**（§6.3「その他（理由必須）」）。 */
export const RESOLUTION_NOTE_MAX_LENGTH = 500;

/** 一覧が一度に返す上限。§10.6 の性能要件（3 秒）に収まる大きさ。 */
export const FINDING_LIST_MAX_LIMIT = 200;

// ────────────────────────────────────────────────────────────
// 入力
// ────────────────────────────────────────────────────────────

/**
 * 状態の変更（§6.3）。
 *
 * **状態と理由しか受け取らない。** 確信度・重要度・本文を書き換える欄を
 * 足さないこと。照合が出した根拠を人が上書きできると、差異の記録が
 * 「後から辻褄を合わせられるもの」になる。
 */
export const findingStatusRequestSchema = z
  .object({
    status: findingAssignableStatusSchema,
    resolutionCode: z.enum(FINDING_RESOLUTION_CODES).nullable().default(null),
    resolutionNote: z.string().max(RESOLUTION_NOTE_MAX_LENGTH).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const codes: readonly string[] =
      value.status === "RESOLVED"
        ? FINDING_RESOLVED_CODES
        : value.status === "FALSE_POSITIVE"
          ? FINDING_FALSE_POSITIVE_CODES
          : [];

    if (codes.length === 0) {
      // `OPEN` / `REVIEWING` は「まだ閉じていない」。解決コードを持たせない。
      if (value.resolutionCode !== null) {
        ctx.addIssue({ code: "custom", path: ["resolutionCode"], message: "UNEXPECTED_CODE" });
      }
      return;
    }

    if (value.resolutionCode === null || !codes.includes(value.resolutionCode)) {
      ctx.addIssue({ code: "custom", path: ["resolutionCode"], message: "CODE_REQUIRED" });
      return;
    }
    // §6.3「その他（理由必須）」。**空白だけの理由を通さない。**
    if (value.resolutionCode === "OTHER" && (value.resolutionNote ?? "").trim() === "") {
      ctx.addIssue({ code: "custom", path: ["resolutionNote"], message: "NOTE_REQUIRED" });
    }
  });

export type FindingStatusRequest = z.infer<typeof findingStatusRequestSchema>;

// ────────────────────────────────────────────────────────────
// 出力
// ────────────────────────────────────────────────────────────

/** 一覧の 1 行（§6.1 の表）。 */
export const findingSummarySchema = z.object({
  id: resourceIdSchema,
  propertyId: resourceIdSchema,
  propertyName: z.string(),
  roomId: resourceIdSchema,
  roomNumber: z.string(),
  businessDate: businessDateSchema,
  ruleCode: z.string(),
  severity: findingSeveritySchema,
  /** 0〜100（§1.3 MUST。**必ず示す**）。 */
  confidence: z.number().int().min(0).max(100),
  title: z.string(),
  status: findingStatusSchema,
  resolutionCode: z.string().nullable(),
  /** epoch ミリ秒。 */
  createdAt: z.number().int(),
});

export type FindingSummary = z.infer<typeof findingSummarySchema>;

/** 状態ごとの件数（§6.1 の「未対応 12 ・ 確認中 3 ・ …」）。 */
export const findingCountsSchema = z.object({
  OPEN: z.number().int().min(0),
  REVIEWING: z.number().int().min(0),
  RESOLVED: z.number().int().min(0),
  FALSE_POSITIVE: z.number().int().min(0),
  SUPPRESSED: z.number().int().min(0),
});

export type FindingCounts = z.infer<typeof findingCountsSchema>;

/**
 * 一覧（§6.1）。
 *
 * `suppressedCount` は §4.3 の「抑制された差異 N 件」。**沈黙させない。**
 * 差異そのものは作られていないので `data` には現れず、
 * `reconciliationRun.findingsSuppressed` の合計として出す。
 */
export const findingListResponseSchema = z.object({
  data: z.array(findingSummarySchema),
  counts: findingCountsSchema,
  suppressedCount: z.number().int().min(0),
});

export type FindingListResponse = z.infer<typeof findingListResponseSchema>;

/** ① 稼働記録（A 系統 / §6.2）。**宿泊者の情報を持たない。** */
export const findingOccupancyFactSchema = z.object({
  source: z.string(),
  isOccupied: z.boolean(),
  guestCount: z.number().int().min(0),
  reservationRef: z.string().nullable(),
  isStayover: z.boolean(),
  isHouseUse: z.boolean(),
  isComplimentary: z.boolean(),
  importedAt: z.number().int(),
});

export type FindingOccupancyFact = z.infer<typeof findingOccupancyFactSchema>;

/** ② 現場観察（B 系統 / §6.2）。 */
export const findingObservationFactSchema = z.object({
  bedsUsed: z.number().int().min(0),
  trashLevel: z.string(),
  bathTowelUsed: z.number().int().min(0),
  faceTowelUsed: z.number().int().min(0),
  bathMatUsed: z.number().int().min(0),
  usedDefaults: z.boolean(),
  /** 入力所要時間（§6.2 の「入力時間 18秒」）。 */
  inputDurationMs: z.number().int().nullable(),
  recordedAt: z.number().int(),
  /** 記録した人の表示名。**見せてよい相手かは組み立て側が絞る**（INV-06）。 */
  recordedByName: z.string().nullable(),
});

export type FindingObservationFact = z.infer<typeof findingObservationFactSchema>;

/** ③ 物理信号（C 系統 / §6.2）の 1 件。 */
export const findingSignalFactSchema = z.object({
  signalType: z.string(),
  occurredAt: z.number().int(),
  actorType: z.string().nullable(),
});

export type FindingSignalFact = z.infer<typeof findingSignalFactSchema>;

/**
 * 3 系統（§6.2 MUST）。
 *
 * **3 つの鍵を必ず持つ。** `null` は「この系統のデータが無い」で、
 * 画面はそこに「データなし」と出す。鍵を省略する形にしないこと。
 *
 * `observationSkipped` は「今回は記録しない」を現場が選んだ場合
 * （PK-SPEC-P3 §1.3）。**データが無いのとは別物。** 記録が届かなかった
 * のか、記録しないことを選んだのかを画面で区別できるようにする。
 */
export const findingSourcesSchema = z.object({
  occupancy: findingOccupancyFactSchema.nullable(),
  observation: findingObservationFactSchema.nullable(),
  observationSkipped: z.boolean(),
  signals: z.array(findingSignalFactSchema).nullable(),
});

export type FindingSources = z.infer<typeof findingSourcesSchema>;

/** 正当な入室の記録（§6.2 の「入室記録」）。 */
export const findingAccessLogSchema = z.object({
  purpose: z.string(),
  enteredAt: z.number().int(),
  exitedAt: z.number().int().nullable(),
});

export type FindingAccessLog = z.infer<typeof findingAccessLogSchema>;

/** 前後の業務日の稼働（§6.2 の「前後の稼働」）。 */
export const findingAdjacentOccupancySchema = z.object({
  businessDate: businessDateSchema,
  isOccupied: z.boolean().nullable(),
  guestCount: z.number().int().min(0).nullable(),
});

export type FindingAdjacentOccupancy = z.infer<typeof findingAdjacentOccupancySchema>;

/** 参考情報（§6.2 の中段）。**判定の根拠ではない。** */
export const findingReferenceSchema = z.object({
  photoCount: z.number().int().min(0),
  accessLogs: z.array(findingAccessLogSchema),
  roomSaleStatus: z.string(),
  roomHousekeepingStatus: z.string(),
  adjacent: z.array(findingAdjacentOccupancySchema),
});

export type FindingReference = z.infer<typeof findingReferenceSchema>;

/**
 * 対応履歴（§6.2 の下段）。
 *
 * **専用の履歴表を作っていない。** §2.5 の `auditFinding` が持つのは
 * 「作られた時刻」と「閉じた時刻」だけで、途中経過の行は無い。
 * 経過を全部残すなら表が要るが、それは §2.5 に無い設計判断になる
 * （DECISIONS #114）。ここは 2 点を組み立てて返す。
 */
export const findingHistoryEntrySchema = z.object({
  at: z.number().int(),
  kind: z.enum(["DETECTED", "STATUS_CHANGED"]),
  status: findingStatusSchema.nullable(),
  resolutionCode: z.string().nullable(),
});

export type FindingHistoryEntry = z.infer<typeof findingHistoryEntrySchema>;

/** 詳細（§6.2）。 */
export const findingDetailResponseSchema = z.object({
  finding: findingSummarySchema.extend({
    ruleVersion: z.string(),
    summary: z.string(),
    matchedSignals: z.array(z.string()),
    resolutionNote: z.string().nullable(),
    resolvedAt: z.number().int().nullable(),
  }),
  sources: findingSourcesSchema,
  reference: findingReferenceSchema,
  history: z.array(findingHistoryEntrySchema),
});

export type FindingDetailResponse = z.infer<typeof findingDetailResponseSchema>;

/** 状態変更の応答。**変更後の 1 行だけ返す。** */
export const findingStatusResponseSchema = z.object({ data: findingSummarySchema });

export type FindingStatusResponse = z.infer<typeof findingStatusResponseSchema>;
