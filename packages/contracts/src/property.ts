/**
 * 施設サマリー（施設セレクタのミニバッジと全社サマリー）。
 *
 * task: docs/tasks/P0-21.md
 * 仕様: docs/PK-SPEC-P0.md §23.3
 *
 * ── rollup の列と §23.3 の応答が一致していない ──────────
 * §23.3 の例は `ready` / `inProgress` / `dirty` を返すが、これは**客室の
 * 状態の数**で、`dailyPropertyRollup`（§19.6）が持つのは**タスクの数**
 * （`totalTasks` / `completedTasks` / `reworkTasks`）。仕様の中で対応が
 * 定義されていない。docs/OPEN_QUESTIONS.md #023 に起票してある。
 *
 * **ここでは rollup の列名をそのまま返す。** 客室状態を名乗る数字を
 * タスク数から作ると、画面の「清掃済 48」が何を数えたのか誰にも
 * 説明できなくなる。対応付けは客室ステータスを持つ P1 が決める。
 */

import { z } from "zod";

/** 1 施設ぶんのサマリー。**シャード番号・組織 ID を含めない。** */
export const propertySummarySchema = z.object({
  propertyId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  /**
   * 客室数。**`isSellable = true` のみ**（§24.3）。
   * rollup に客室数の列が無いため、客室マスタから数える。
   */
  roomCount: z.number().int().min(0),
  /**
   * その業務日の rollup が存在するか。
   *
   * **「まだ集計が無い」と「全部 0」を区別するために要る。** 画面は
   * false のとき数字を出さず「集計はまだありません」と述べる。
   * 0 と表示すると、清掃が 1 件も終わっていないように読める。
   */
  hasRollup: z.boolean(),
  totalTasks: z.number().int().min(0),
  completedTasks: z.number().int().min(0),
  reworkTasks: z.number().int().min(0),
  openIssues: z.number().int().min(0),
});

export type PropertySummary = z.infer<typeof propertySummarySchema>;

/** `GET /api/v1/properties/summary` の応答。 */
export const propertySummaryResponseSchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  data: z.array(propertySummarySchema),
});

export type PropertySummaryResponse = z.infer<typeof propertySummaryResponseSchema>;

/** 業務日。`YYYY-MM-DD`（architecture.md §7）。 */
export const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ────────────────────────────────────────────────────────────
// 事業者・税務マスタ（P0-16 / W-11）
// ────────────────────────────────────────────────────────────

/**
 * インボイス登録番号。`T` + 数字 13 桁（billing.md §1 の要件 1）。
 *
 * **チェックディジットを検証しない。** 法人番号の検算式は総務省が
 * 定めているが、個人事業者の登録番号は法人番号ベースではない。
 * 誤った検算で正しい番号を弾くほうが害が大きい。形だけを見る。
 *
 * 未取得の間は空欄でよい。その場合 `isQualifiedInvoice = false` を
 * 記録し、帳票に「適格請求書ではありません」と明記する（billing.md §1）。
 */
export const invoiceRegistrationNumberSchema = z.string().regex(/^T\d{13}$/);

/** 端数処理方式（billing.md §4）。`packages/db` の `TAX_ROUNDING_MODES` と同じ。 */
export const TAX_ROUNDING_MODES = ["FLOOR", "CEIL", "ROUND"] as const;

/**
 * 税務プロファイルの更新。
 *
 * `invoiceRegistrationNumber` は空文字を `null`（未設定）として受ける。
 * **空文字のまま保存しない。** 「空文字が入っている」と「未設定」を
 * 区別できると、適格請求書の判定が 2 通りになる。
 */
export const taxProfileUpdateSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  invoiceRegistrationNumber: z
    .string()
    .trim()
    .transform((value) => (value === "" ? null : value))
    .pipe(z.union([z.null(), invoiceRegistrationNumberSchema])),
  defaultTaxRoundingMode: z.enum(TAX_ROUNDING_MODES),
  postalCode: z.string().trim().max(16).optional(),
  address: z.string().trim().max(200).optional(),
  tel: z.string().trim().max(32).optional(),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
});

export type TaxProfileUpdate = z.infer<typeof taxProfileUpdateSchema>;

/** 角印画像の制約（P0-16）。 */
export const SEAL_IMAGE = {
  maxBytes: 1024 * 1024,
  contentTypes: ["image/png", "image/jpeg"],
} as const;
