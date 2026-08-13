/**
 * 検査結果の集約（P2-04 / PK-SPEC-P2 §4.3〜§4.5）。
 *
 * ルール: .claude/rules/testing.md §3（純粋関数は正例・負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  DEFECT_NOTE_MAX_LENGTH,
  aggregateResult,
  checkInspectionCompletion,
  durationSecondsOf,
  evaluateSelfInspection,
  failedItemIds,
  hasFailure,
  reasonSummaryOf,
  type InspectionItemInput,
} from "./inspectionResult.js";

/** 合格の項目。 */
function pass(id: string): InspectionItemInput {
  return { checklistItemId: id, status: "PASS", defectCode: null, note: null, photoCount: 0 };
}

/** 対象外の項目。 */
function notApplicable(id: string): InspectionItemInput {
  return {
    checklistItemId: id,
    status: "NOT_APPLICABLE",
    defectCode: null,
    note: null,
    photoCount: 0,
  };
}

/** 不合格の項目（既定では §4.3 の 3 点をすべて満たす）。 */
function fail(id: string, overrides: Partial<InspectionItemInput> = {}): InspectionItemInput {
  return {
    checklistItemId: id,
    status: "FAIL",
    defectCode: "DUST",
    note: "洗面台に髪の毛が残っています",
    photoCount: 1,
    ...overrides,
  };
}

/** まだ答えていない項目。 */
function unanswered(id: string): InspectionItemInput {
  return { checklistItemId: id, status: null, defectCode: null, note: null, photoCount: 0 };
}

describe("aggregateResult", () => {
  // ── 正例（PASS になる）──────────────────────────────
  it("全項目 PASS なら PASS", () => {
    expect(aggregateResult([pass("a"), pass("b"), pass("c")])).toBe("PASS");
  });

  it("対象外が混ざっても PASS", () => {
    expect(aggregateResult([pass("a"), notApplicable("b")])).toBe("PASS");
  });

  it("全項目が対象外でも PASS", () => {
    expect(aggregateResult([notApplicable("a"), notApplicable("b")])).toBe("PASS");
  });

  it("1 項目だけの PASS も PASS", () => {
    expect(aggregateResult([pass("a")])).toBe("PASS");
  });

  it("未選択だけでは FAIL にしない（完了可否は別の関数が見る）", () => {
    expect(aggregateResult([unanswered("a"), pass("b")])).toBe("PASS");
  });

  // ── 負例（FAIL になる）──────────────────────────────
  it("1 項目でも FAIL があれば FAIL（§4.3 MUST）", () => {
    expect(aggregateResult([pass("a"), fail("b"), pass("c")])).toBe("FAIL");
  });

  it("最後の項目が FAIL でも FAIL", () => {
    expect(aggregateResult([pass("a"), pass("b"), fail("c")])).toBe("FAIL");
  });

  it("最初の項目が FAIL でも FAIL", () => {
    expect(aggregateResult([fail("a"), pass("b")])).toBe("FAIL");
  });

  it("FAIL と対象外の組み合わせも FAIL", () => {
    expect(aggregateResult([notApplicable("a"), fail("b")])).toBe("FAIL");
  });

  it("全項目 FAIL なら FAIL", () => {
    expect(aggregateResult([fail("a"), fail("b")])).toBe("FAIL");
  });

  it("**全体だけを PASS に上書きする引数が無い**（§4.3 MUST）", () => {
    // 引数は項目の並び 1 つだけ。検査者の申告する全体判定を受け取らない。
    expect(aggregateResult.length).toBe(1);
  });
});

describe("failedItemIds / hasFailure", () => {
  it("FAIL の項目 ID だけを並び順のまま返す", () => {
    expect(failedItemIds([pass("a"), fail("b"), fail("c"), notApplicable("d")])).toEqual(["b", "c"]);
  });

  it("FAIL が無ければ空", () => {
    expect(failedItemIds([pass("a"), notApplicable("b")])).toEqual([]);
    expect(hasFailure([pass("a"), notApplicable("b")])).toBe(false);
  });

  it("FAIL があれば真", () => {
    expect(hasFailure([pass("a"), fail("b")])).toBe(true);
  });
});

describe("checkInspectionCompletion", () => {
  // ── 正例（完了できる）──────────────────────────────
  it("全項目 PASS なら完了できる", () => {
    expect(checkInspectionCompletion([pass("a"), pass("b")]).ok).toBe(true);
  });

  it("対象外だけでも完了できる", () => {
    expect(checkInspectionCompletion([notApplicable("a")]).ok).toBe(true);
  });

  it("FAIL に理由コード・コメント・写真が揃っていれば完了できる（§4.3）", () => {
    expect(checkInspectionCompletion([pass("a"), fail("b")]).ok).toBe(true);
  });

  it("コメントが 200 文字ちょうどでも完了できる", () => {
    const note = "あ".repeat(DEFECT_NOTE_MAX_LENGTH);
    expect(checkInspectionCompletion([fail("a", { note })]).ok).toBe(true);
  });

  it("写真が複数枚でも完了できる", () => {
    expect(checkInspectionCompletion([fail("a", { photoCount: 3 })]).ok).toBe(true);
  });

  // ── 負例（完了できない）────────────────────────────
  it("項目が 1 件も無ければ完了できない（全項目合格にしない）", () => {
    expect(checkInspectionCompletion([]).ok).toBe(false);
  });

  it("未選択の項目があれば完了できない（未選択を PASS とみなさない）", () => {
    const check = checkInspectionCompletion([pass("a"), unanswered("b")]);
    expect(check.ok).toBe(false);
    expect(check.unansweredItemIds).toEqual(["b"]);
  });

  it("FAIL に理由コードが無ければ完了できない（§4.3）", () => {
    const check = checkInspectionCompletion([fail("a", { defectCode: null })]);
    expect(check.ok).toBe(false);
    expect(check.missingDefectCodeItemIds).toEqual(["a"]);
  });

  it("FAIL にコメントが無ければ完了できない（§4.3）", () => {
    const check = checkInspectionCompletion([fail("a", { note: "" })]);
    expect(check.ok).toBe(false);
    expect(check.missingNoteItemIds).toEqual(["a"]);
  });

  it("FAIL のコメントが 200 文字を超えたら完了できない（§4.3）", () => {
    const note = "あ".repeat(DEFECT_NOTE_MAX_LENGTH + 1);
    const check = checkInspectionCompletion([fail("a", { note })]);
    expect(check.ok).toBe(false);
    expect(check.missingNoteItemIds).toEqual(["a"]);
  });

  it("FAIL に写真が無ければ完了できない（§4.3）", () => {
    const check = checkInspectionCompletion([fail("a", { photoCount: 0 })]);
    expect(check.ok).toBe(false);
    expect(check.missingPhotoItemIds).toEqual(["a"]);
  });

  it("**足りないものを 1 回で返す**（直しては拒否される往復を作らない）", () => {
    const check = checkInspectionCompletion([
      fail("a", { defectCode: null, note: null, photoCount: 0 }),
      unanswered("b"),
    ]);
    expect(check).toEqual({
      ok: false,
      unansweredItemIds: ["b"],
      missingDefectCodeItemIds: ["a"],
      missingNoteItemIds: ["a"],
      missingPhotoItemIds: ["a"],
    });
  });

  it("PASS の項目に理由コード・写真を求めない", () => {
    const check = checkInspectionCompletion([pass("a"), notApplicable("b")]);
    expect(check.missingDefectCodeItemIds).toEqual([]);
    expect(check.missingPhotoItemIds).toEqual([]);
  });
});

describe("reasonSummaryOf", () => {
  it("FAIL の理由コードを最初に現れた順で並べる", () => {
    const summary = reasonSummaryOf([
      pass("a"),
      fail("b", { defectCode: "HAIR" }),
      fail("c", { defectCode: "DUST" }),
    ]);
    expect(summary).toBe("HAIR,DUST");
  });

  it("同じ理由コードは畳む", () => {
    const summary = reasonSummaryOf([
      fail("a", { defectCode: "DUST" }),
      fail("b", { defectCode: "DUST" }),
    ]);
    expect(summary).toBe("DUST");
  });

  it("FAIL が無ければ空文字", () => {
    expect(reasonSummaryOf([pass("a"), notApplicable("b")])).toBe("");
  });

  it("**コメント本文を含めない**（要約に現場の書きぶりを混ぜない）", () => {
    const summary = reasonSummaryOf([fail("a", { note: "洗面台に髪の毛が残っています" })]);
    expect(summary).toBe("DUST");
    expect(summary).not.toContain("髪");
  });

  it("PASS の項目の理由コードは拾わない", () => {
    const summary = reasonSummaryOf([
      { checklistItemId: "a", status: "PASS", defectCode: "DUST", note: null, photoCount: 0 },
      fail("b", { defectCode: "ODOR" }),
    ]);
    expect(summary).toBe("ODOR");
  });
});

describe("evaluateSelfInspection", () => {
  const CLEANER = "a1b2c3__mem_CLEANER";
  const INSPECTOR = "a1b2c3__mem_INSPECTOR";

  it("別人なら通常の検査", () => {
    expect(evaluateSelfInspection(CLEANER, INSPECTOR, false, null)).toEqual({
      kind: "ALLOWED",
      selfApproved: false,
    });
  });

  it("担当者が未割当なら通常の検査", () => {
    expect(evaluateSelfInspection(null, INSPECTOR, false, null)).toEqual({
      kind: "ALLOWED",
      selfApproved: false,
    });
  });

  it("本人・施設が許していない → 禁止（既定 / security.md §1）", () => {
    expect(evaluateSelfInspection(CLEANER, CLEANER, false, "急ぎのため")).toEqual({
      kind: "FORBIDDEN",
    });
  });

  it("本人・施設が許している・理由なし → 理由が要る", () => {
    expect(evaluateSelfInspection(CLEANER, CLEANER, true, null)).toEqual({
      kind: "REASON_REQUIRED",
    });
  });

  it("本人・施設が許している・空白だけの理由 → 理由が要る", () => {
    expect(evaluateSelfInspection(CLEANER, CLEANER, true, "   ")).toEqual({
      kind: "REASON_REQUIRED",
    });
  });

  it("本人・施設が許している・理由あり → 自己検査として通す（監査ログが要る）", () => {
    expect(evaluateSelfInspection(CLEANER, CLEANER, true, "他の検査者が不在")).toEqual({
      kind: "ALLOWED",
      selfApproved: true,
    });
  });
});

describe("durationSecondsOf", () => {
  it("秒に切り捨てる", () => {
    expect(durationSecondsOf(1_000, 91_900)).toBe(90);
  });

  it("同時刻なら 0", () => {
    expect(durationSecondsOf(5_000, 5_000)).toBe(0);
  });

  it("**負にならない**（時計が戻っても 0 で止める）", () => {
    expect(durationSecondsOf(10_000, 1_000)).toBe(0);
  });
});
