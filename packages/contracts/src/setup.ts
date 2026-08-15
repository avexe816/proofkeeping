/**
 * セットアップウィザードの進行（PK-SPEC-P7 §2.3）。
 *
 * task:  docs/tasks/P7-01.md
 * 決定:  docs/DECISIONS.md #180（表にせず JSON 1 列で持つ）
 *
 * ── 6 ステップは仕様の並びそのまま ──────────────────────
 *   1 会社情報 / 2 最初の施設 / 3 客室の登録 /
 *   4 チェックリスト / 5 スタッフの招待 / 6 完了
 *
 * ── 「スキップ」を状態として持つ ────────────────────────
 * §2.3 MUST は「各ステップは『あとで設定する』でスキップできる」。
 * **やっていない**と**やらないと決めた**を区別しないと、次に開いたとき
 * 同じステップで止まり続ける。`SKIPPED` はそのための状態で、
 * **後から `DONE` にできる**（スキップは取り消せる）。
 *
 * ── データから導かない ──────────────────────────────────
 * 「客室が 1 室でもあれば Step 3 は完了」と導く手もあるが、
 * **ウィザードを使わずに作った組織と区別がつかない。** 導入前から
 * 客室があるのに「完了しました」と出るのは案内として誤り。
 * ここは**ウィザードの中で何をしたか**だけを持つ。
 */

import { z } from "zod";

/** ステップ。**並び順に意味がある**（画面はこの順で出す）。 */
export const SETUP_STEPS = [
  "company",
  "property",
  "rooms",
  "checklist",
  "staff",
  "done",
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export const setupStepSchema = z.enum(SETUP_STEPS);

/** ステップの状態。行が無い（未着手）を第 3 の状態として扱う。 */
export const SETUP_STEP_STATES = ["DONE", "SKIPPED"] as const;

export type SetupStepState = (typeof SETUP_STEP_STATES)[number];

export const setupStepStateSchema = z.enum(SETUP_STEP_STATES);

/**
 * `organization.setup_state` に入る JSON。
 *
 * **`version` を持つ。** 形を変えるときは上げること。読み取り側は
 * 知らない版を「まだ何もしていない」として扱う（ウィザードが出るだけで
 * 害が無い）。壊れた値で画面が落ちるほうが困る。
 */
export const SETUP_STATE_VERSION = 1;

export const setupStateSchema = z.object({
  version: z.literal(SETUP_STATE_VERSION),
  /** 触れたステップだけが入る。**未着手のステップは鍵ごと無い。** */
  steps: z.partialRecord(setupStepSchema, setupStepStateSchema),
  /** ウィザードを閉じた時刻（epoch ms）。`null` なら継続中。 */
  completedAt: z.number().int().nonnegative().nullable(),
});

export type SetupState = z.infer<typeof setupStateSchema>;

/** 何もしていない状態。**`organization.setup_state` が `null` のときの既定。** */
export const EMPTY_SETUP_STATE: SetupState = {
  version: SETUP_STATE_VERSION,
  steps: {},
  completedAt: null,
};

/** 会社情報（Step 1）の入力。**すべて任意**（スキップできるため）。 */
export const setupCompanySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  orgType: z.enum(["OPERATOR", "VENDOR", "OWNER"]).optional(),
});

export type SetupCompanyRequest = z.infer<typeof setupCompanySchema>;
