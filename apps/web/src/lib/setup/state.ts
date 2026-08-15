/**
 * セットアップウィザードの進行を読み書きする**純粋関数**（PK-SPEC-P7 §2.3）。
 *
 * task:  docs/tasks/P7-01.md
 * 決定:  docs/DECISIONS.md #180
 *
 * ── 壊れた値で落とさない ────────────────────────────────
 * `organization.setup_state` は JSON の text。手で書き換えられうるし、
 * 版を上げれば古い値も残る。**読めない値は「まだ何もしていない」**として
 * 扱う。ウィザードがもう一度出るだけで、業務は止まらない。
 * 逆に throw すると、**壊れた 1 列で管理画面が開かなくなる。**
 *
 * ── ここに DB を持ち込まない ────────────────────────────
 * 読み書きの入口は `routes/app/setup.tsx`。この層は文字列と状態の変換だけ。
 */

import {
  EMPTY_SETUP_STATE,
  SETUP_STEPS,
  setupStateSchema,
  type SetupState,
  type SetupStep,
  type SetupStepState,
} from "@pk/contracts";

/** 列の値を状態にする。**読めなければ空。** */
export function parseSetupState(stored: string | null): SetupState {
  if (stored === null) return EMPTY_SETUP_STATE;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return EMPTY_SETUP_STATE;
  }
  const parsed = setupStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_SETUP_STATE;
}

/** 状態を列の値にする。 */
export function serializeSetupState(state: SetupState): string {
  return JSON.stringify(state);
}

/**
 * 1 ステップの結果を記録する。**同じステップを何度でも上書きできる。**
 *
 * スキップしたステップを後から `DONE` にできる（§2.3 MUST の
 * 「あとで設定する」は取り消せる約束）。
 */
export function markStep(
  state: SetupState,
  step: SetupStep,
  result: SetupStepState,
): SetupState {
  return { ...state, steps: { ...state.steps, [step]: result } };
}

/** ウィザードを閉じる。**`now` は注入する**（この層に時計を持ち込まない）。 */
export function completeSetup(state: SetupState, now: Date): SetupState {
  return { ...state, completedAt: now.getTime() };
}

/** 閉じたウィザードをもう一度開く。**記録は消さない。** */
export function reopenSetup(state: SetupState): SetupState {
  return { ...state, completedAt: null };
}

/** そのステップの状態。触れていなければ `null`。 */
export function stateOf(state: SetupState, step: SetupStep): SetupStepState | null {
  return state.steps[step] ?? null;
}

/**
 * 次に開くステップ。**未着手の最初の 1 つ。**
 *
 * スキップしたステップは飛ばす。全部触れていれば `"done"`。
 * **`"done"` 自身は「次」に選ばない**（最後の 1 枚は常に確認の画面）。
 */
export function nextStep(state: SetupState): SetupStep {
  for (const step of SETUP_STEPS) {
    if (step === "done") continue;
    if (stateOf(state, step) === null) return step;
  }
  return "done";
}

/** 「完了」と数えたステップ数。**スキップは数えない。** */
export function doneCount(state: SetupState): number {
  return SETUP_STEPS.filter((step) => step !== "done" && stateOf(state, step) === "DONE").length;
}

/** 進捗の分母。`done` を除いた 5 ステップ。 */
export const SETUP_STEP_TOTAL = SETUP_STEPS.length - 1;

/** ウィザードを閉じてよいか。**触れ終わっていれば、中身がスキップでもよい。** */
export function canComplete(state: SetupState): boolean {
  return SETUP_STEPS.every((step) => step === "done" || stateOf(state, step) !== null);
}
