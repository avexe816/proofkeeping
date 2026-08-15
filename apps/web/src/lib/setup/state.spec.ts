/**
 * セットアップウィザードの進行（P7-01 / PK-SPEC-P7 §2.3）。
 *
 * **見ているのは「壊れた値で落ちないこと」と「スキップの扱い」。**
 * §2.3 MUST の「各ステップは『あとで設定する』でスキップできる」は、
 * スキップを状態として持たないと満たせない（次に開いたとき同じ
 * ステップで止まり続ける）。
 */

import { EMPTY_SETUP_STATE, SETUP_STEPS, type SetupState } from "@pk/contracts";
import { describe, expect, it } from "vitest";

import {
  SETUP_STEP_TOTAL,
  canComplete,
  completeSetup,
  doneCount,
  markStep,
  nextStep,
  parseSetupState,
  reopenSetup,
  serializeSetupState,
  stateOf,
} from "./state.js";

const NOW = new Date("2026-08-15T09:00:00.000Z");

function touchAll(result: "DONE" | "SKIPPED" = "DONE"): SetupState {
  let state = EMPTY_SETUP_STATE;
  for (const step of SETUP_STEPS) {
    if (step === "done") continue;
    state = markStep(state, step, result);
  }
  return state;
}

describe("parseSetupState", () => {
  it("`null` は空の状態", () => {
    expect(parseSetupState(null)).toEqual(EMPTY_SETUP_STATE);
  });

  it("**壊れた JSON でも落ちない**（空として扱う）", () => {
    for (const stored of ["", "{", "not json", "[]", "null", "123"]) {
      expect(parseSetupState(stored)).toEqual(EMPTY_SETUP_STATE);
    }
  });

  it("**知らない版は空として扱う**（画面を落とさない）", () => {
    const stored = JSON.stringify({ version: 99, steps: { company: "DONE" }, completedAt: null });
    expect(parseSetupState(stored)).toEqual(EMPTY_SETUP_STATE);
  });

  it("知らないステップ名・状態が混ざっていれば空として扱う", () => {
    const stored = JSON.stringify({ version: 1, steps: { unknown: "DONE" }, completedAt: null });
    expect(parseSetupState(stored)).toEqual(EMPTY_SETUP_STATE);
    const badState = JSON.stringify({ version: 1, steps: { company: "MAYBE" }, completedAt: null });
    expect(parseSetupState(badState)).toEqual(EMPTY_SETUP_STATE);
  });

  it("書いて読むと同じ状態に戻る", () => {
    const state = completeSetup(markStep(EMPTY_SETUP_STATE, "company", "SKIPPED"), NOW);
    expect(parseSetupState(serializeSetupState(state))).toEqual(state);
  });
});

describe("markStep", () => {
  it("記録できる。**同じステップを上書きできる**", () => {
    let state = markStep(EMPTY_SETUP_STATE, "rooms", "SKIPPED");
    expect(stateOf(state, "rooms")).toBe("SKIPPED");
    state = markStep(state, "rooms", "DONE");
    expect(stateOf(state, "rooms")).toBe("DONE");
  });

  it("元の状態を書き換えない（純粋）", () => {
    const before = EMPTY_SETUP_STATE;
    markStep(before, "rooms", "DONE");
    expect(stateOf(before, "rooms")).toBeNull();
  });

  it("触れていないステップは `null`", () => {
    expect(stateOf(EMPTY_SETUP_STATE, "staff")).toBeNull();
  });
});

describe("nextStep", () => {
  it("何もしていなければ最初のステップ", () => {
    expect(nextStep(EMPTY_SETUP_STATE)).toBe("company");
  });

  it("**スキップしたステップは飛ばす**（同じ所で止まらない）", () => {
    const state = markStep(EMPTY_SETUP_STATE, "company", "SKIPPED");
    expect(nextStep(state)).toBe("property");
  });

  it("全部触れたら `done`", () => {
    expect(nextStep(touchAll("SKIPPED"))).toBe("done");
    expect(nextStep(touchAll("DONE"))).toBe("done");
  });

  it("**`done` を「次」として選ばない**（最後は必ず確認の画面）", () => {
    const state = markStep(touchAll(), "done", "DONE");
    expect(nextStep(state)).toBe("done");
  });
});

describe("canComplete", () => {
  it("**触れ終わっていれば、中身がスキップでも閉じられる**（§2.3 MUST）", () => {
    expect(canComplete(touchAll("SKIPPED"))).toBe(true);
  });

  it("1 つでも未着手なら閉じられない", () => {
    let state = EMPTY_SETUP_STATE;
    // `staff` にだけ触れない。
    for (const step of SETUP_STEPS) {
      if (step === "done" || step === "staff") continue;
      state = markStep(state, step, "DONE");
    }
    expect(canComplete(state)).toBe(false);
  });
});

describe("doneCount", () => {
  it("**スキップは数えない**", () => {
    expect(doneCount(touchAll("SKIPPED"))).toBe(0);
    expect(doneCount(touchAll("DONE"))).toBe(SETUP_STEP_TOTAL);
  });

  it("分母は `done` を除いた 5", () => {
    expect(SETUP_STEP_TOTAL).toBe(5);
  });
});

describe("completeSetup / reopenSetup", () => {
  it("閉じると時刻が入る。**時計は注入する**", () => {
    expect(completeSetup(EMPTY_SETUP_STATE, NOW).completedAt).toBe(NOW.getTime());
  });

  it("**開き直しても記録は消えない**", () => {
    const closed = completeSetup(markStep(EMPTY_SETUP_STATE, "rooms", "DONE"), NOW);
    const reopened = reopenSetup(closed);
    expect(reopened.completedAt).toBeNull();
    expect(stateOf(reopened, "rooms")).toBe("DONE");
  });
});
