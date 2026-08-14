/**
 * ルール設定 API の入出力（PK-SPEC-P4 §2.7 / W-25）。
 *
 * task: docs/tasks/P4-13.md
 *
 * ```
 * GET   /api/v1/rule-configs?propertyId=
 * PATCH /api/v1/rule-configs/:ruleCode
 * ```
 *
 * ── 経路が §8 と違う ────────────────────────────────────
 * §8 は `PATCH /api/v1/rule-configs/:id` と書くが、**`ruleConfig` は行が
 * 無いのが既定の状態**（有効・上書きなし・閾値なし）。まだ触っていない
 * ルールには `id` が無く、`:id` では最初の 1 回を送れない。
 * `:ruleCode` を鍵にして upsert する（DECISIONS #118）。
 *
 * ── engine を変えずに調整できること ─────────────────────
 * P4-13 の完了条件。ここで送れるのは**有効・無効／重要度の上書き／閾値**の
 * 3 つだけで、判定そのものは `packages/engine` にある。
 * **ルールの条件式を送る欄を足さないこと**（§13 の「顧客が独自ルールを
 * 定義できるようにするか」は v2 以降の未決事項）。
 *
 * ── 閾値は engine が知っている鍵だけが効く ──────────────
 * §2.7。知らない鍵を入れても無視される（`RuleContext.thresholds` の注記）。
 * **ここで鍵を検証しない。** 検証すると、engine にルールを足すたびに
 * contracts を直すことになる。値の形（有限の数値）だけを見る。
 */

import { z } from "zod";

import { findingSeveritySchema } from "./finding.js";
import { resourceIdSchema } from "./task.js";

/** API のエラーコード。**文言を載せない**（画面が i18n キーへ写す）。 */
export const RULE_CONFIG_ERROR_CODES = ["INVALID_REQUEST", "NOT_FOUND"] as const;

export type RuleConfigErrorCode = (typeof RULE_CONFIG_ERROR_CODES)[number];

export const ruleConfigErrorSchema = z.object({ error: z.enum(RULE_CONFIG_ERROR_CODES) });

export type RuleConfigError = z.infer<typeof ruleConfigErrorSchema>;

/**
 * 設定できるルールコード（§3.1 の 14 個）。
 *
 * **実装済みのルールとは別物。** ここに載っていても engine に実体が
 * 無ければ動かない（`findRule()` が `undefined` を返す）。
 * 一覧の応答は `isImplemented` でその区別を示す。
 */
export const RULE_CODES = [
  "R001",
  "R002",
  "R003",
  "R004",
  "R005",
  "R006",
  "R007",
  "R008",
  "R009",
  "R010",
  "R011",
  "R012",
  "R013",
  "R014",
] as const;

export const ruleCodeSchema = z.enum(RULE_CODES);

export type RuleCodeValue = (typeof RULE_CODES)[number];

/**
 * 閾値の 1 つ。
 *
 * **`z.number()` が既に `NaN` / `Infinity` を弾く**（Zod v4 の既定）。
 * `.finite()` は no-op になったので付けていない。
 */
const thresholdValueSchema = z.number();

/** 閾値の上限。**鍵の数を絞る**（画面から任意の大きさの JSON を入れさせない）。 */
export const MAX_THRESHOLD_KEYS = 20;

export const thresholdsSchema = z
  .record(z.string().min(1).max(64), thresholdValueSchema)
  .refine((value) => Object.keys(value).length <= MAX_THRESHOLD_KEYS, {
    message: "TOO_MANY_KEYS",
  });

/**
 * 設定の更新（§2.7）。
 *
 * **3 つとも必ず送る。** 部分更新にすると「閾値だけ送ったら重要度の
 * 上書きが消えた／残った」がクライアントごとに割れる。画面は現在の値を
 * 読んでから丸ごと送る。
 */
export const ruleConfigUpdateRequestSchema = z.object({
  /** `null` は組織の既定（§2.7）。省略時も組織の既定。 */
  propertyId: resourceIdSchema.nullable().default(null),
  isEnabled: z.boolean(),
  severityOverride: findingSeveritySchema.nullable().default(null),
  thresholds: thresholdsSchema.default({}),
});

export type RuleConfigUpdateRequest = z.infer<typeof ruleConfigUpdateRequestSchema>;

/** 一覧の 1 行。**設定が無いルールも「既定のまま」として並べる。** */
export const ruleConfigSchema = z.object({
  ruleCode: ruleCodeSchema,
  /** §3.1 の名称。**engine の `Rule.title`**（未実装なら空文字）。 */
  title: z.string(),
  /** engine に実体があるか。**無ければ設定しても動かない。** */
  isImplemented: z.boolean(),
  isEnabled: z.boolean(),
  severityOverride: findingSeveritySchema.nullable(),
  thresholds: z.record(z.string(), z.number()),
  /** この施設に固有の行があるか。偽なら組織の既定（または未設定）。 */
  hasPropertyOverride: z.boolean(),
  /** 一度も触っていないか。**「既定に戻した」と区別する。** */
  isDefault: z.boolean(),
});

export type RuleConfigSummary = z.infer<typeof ruleConfigSchema>;

export const ruleConfigListResponseSchema = z.object({
  propertyId: resourceIdSchema,
  data: z.array(ruleConfigSchema),
});

export type RuleConfigListResponse = z.infer<typeof ruleConfigListResponseSchema>;

export const ruleConfigUpdateResponseSchema = z.object({ data: ruleConfigSchema });

export type RuleConfigUpdateResponse = z.infer<typeof ruleConfigUpdateResponseSchema>;
