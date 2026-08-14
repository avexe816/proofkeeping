/**
 * 組織ダッシュボード（W-02 / PK-SPEC-P5 §7.1）。
 *
 * task: docs/tasks/P5-14.md
 *
 * ── 割合を返さない ──────────────────────────────────────
 * 完了率・合格率・再清掃率・平均清掃時間は、**分子と分母を整数のまま
 * 返して画面が割る。** サーバーで割ると、小数の丸め方が API の仕様に
 * 混ざり、「98.2% と 98.15% のどちらが正か」を契約で決める羽目になる。
 * 分母が 0 の月（清掃が 1 件も無い）を `null` と `0` のどちらで表すか、
 * という同じ問題も避けられる。**画面は分母 0 を「—」と描く。**
 *
 * ── 金額は `null` を取りうる ────────────────────────────
 * 清掃費用は**確定した請求書の明細**から来る（DECISIONS #132）。
 * その月の請求書がまだ無ければ `null`。**0 円ではない。**
 * 「無償だった」と「まだ確定していない」を同じ数字で表さない。
 *
 * ── 施設サマリーと形を揃えない ──────────────────────────
 * `property.ts` の `propertySummarySchema` は**単日**の施設セレクタ用で、
 * こちらは**月次**。列が似ているからと共有すると、片方の都合で
 * もう片方が壊れる。別の型として置く。
 */

import { z } from "zod";

/** `YYYY-MM`。**業務日の先頭 7 文字**（architecture.md §7）。 */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** 集計の素（分子・分母のまま）。施設 1 件ぶんにも全社ぶんにも使う。 */
const rollupMetricsShape = {
  /** 清掃実績。**取り消したタスクを含まない。** */
  totalTasks: z.number().int().min(0),
  completedTasks: z.number().int().min(0),
  /** 差戻しを受けたことがあるタスクの数。 */
  reworkTasks: z.number().int().min(0),
  /** 完了したタスクの実作業時間の合計（分）。 */
  totalMinutes: z.number().int().min(0),
  /** 検査の結果が確定したタスクの数。**初回検査合格率の分母。** */
  inspectedTasks: z.number().int().min(0),
  /** そのうち 1 回目で合格した数。**分子。** */
  firstPassTasks: z.number().int().min(0),
  /** その期間に検出された重大な差異の件数。 */
  findingsHigh: z.number().int().min(0),
} as const;

/** 全社サマリー（§7.1 の上段）。 */
export const orgDashboardSummarySchema = z.object({
  propertyCount: z.number().int().min(0),
  /** `isSellable = true` の客室数（PK-SPEC-P0 §24.3）。 */
  roomCount: z.number().int().min(0),
  ...rollupMetricsShape,
  /** 清掃費用合計（税抜・整数・円）。**確定した請求書が無ければ `null`。** */
  cleaningCost: z.number().int().nullable(),
});

export type OrgDashboardSummary = z.infer<typeof orgDashboardSummarySchema>;

/** 施設別比較の 1 行（§7.1 の中段）。 */
export const orgDashboardPropertySchema = z.object({
  propertyId: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  roomCount: z.number().int().min(0),
  ...rollupMetricsShape,
  cleaningCost: z.number().int().nullable(),
});

export type OrgDashboardProperty = z.infer<typeof orgDashboardPropertySchema>;

/**
 * 要対応（§7.1 の下段）。**件数だけ。**
 *
 * 中身は既存の画面（W-06 / 忘れ物 / 不具合 / 締め）が持っている。
 * ここで一覧を返すと、同じものを 2 か所が組み立てることになる。
 */
export const orgDashboardActionsSchema = z.object({
  /** 未対応の差異レポート（`OPEN` / `REVIEWING`）。 */
  openFindings: z.number().int().min(0),
  /** 未解決の設備不具合。 */
  openIssues: z.number().int().min(0),
  /** 保管期限が近い忘れ物。 */
  expiringLostItems: z.number().int().min(0),
  /** 未締めの請求期間（`OPEN` / `REVIEWING` / `AGREED`）。 */
  unclosedBillingPeriods: z.number().int().min(0),
});

export type OrgDashboardActions = z.infer<typeof orgDashboardActionsSchema>;

/** `GET /api/v1/dashboard/org` の応答。 */
export const orgDashboardResponseSchema = z.object({
  month: monthSchema,
  /** 集計した業務日の範囲（両端を含む）。 */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * その月に集計の行が 1 つでもあるか。
   *
   * **「まだ集計が無い」と「全部 0」を区別する**（`property.ts` の
   * `hasRollup` と同じ理由）。画面は false のとき数字を出さない。
   */
  hasRollup: z.boolean(),
  summary: orgDashboardSummarySchema,
  properties: z.array(orgDashboardPropertySchema),
  actions: orgDashboardActionsSchema,
});

export type OrgDashboardResponse = z.infer<typeof orgDashboardResponseSchema>;

/** 「保管期限が近い」とみなす日数（§7.1 の要対応）。 */
export const LOST_ITEM_EXPIRY_WARNING_DAYS = 14;
