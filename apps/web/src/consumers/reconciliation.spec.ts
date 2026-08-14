/**
 * 稼働照合バッチのテスト（P4-05 / PK-SPEC-P4 §5）。
 *
 * ルール: .claude/rules/testing.md §4（冪等: 3 回実行しても結果が変わらない）
 *
 * ── どこで何を押さえているか ────────────────────────────
 * `runReconciliation()` を丸ごと動かすには、D1 の代役へ 7 本のクエリ結果を
 * 実行順どおりに積み、さらに DO の代役を用意することになる。順序に依存した
 * テストは実装の読み取り順を変えただけで壊れる（`baselineLearning.spec.ts`
 * と同じ判断）。**結果が決まる場所ごとに分けて押さえる。**
 *
 *   ① 二重起動の拒否 …… `durable/ReconciliationLock.spec.ts`
 *   ② 差異が重複しない … `packages/db/.../reconciliation.spec.ts`
 *   ③ 判定そのもの …… `packages/engine/.../rules/R001.spec.ts` ほか
 *   ④ ここ …… メッセージの検証と、engine へ渡す値の写し方
 */

import { describe, expect, it } from "vitest";

import {
  daysBetween,
  falsePositiveCountsOf,
  isReconciliationMessage,
  saleStatusOf,
  type ReconciliationMessage,
} from "./reconciliation.js";

const MESSAGE: ReconciliationMessage = {
  kind: "RECONCILIATION",
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  propertyId: "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6",
  businessDate: "2026-09-09",
  mode: "AUTO",
  requestedById: null,
  requestedAtMs: Date.UTC(2026, 8, 9, 17, 0, 0),
};

describe("isReconciliationMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isReconciliationMessage(MESSAGE)).toBe(true);
  });

  it("手動実行（`MANUAL` + 依頼者）も受け入れる", () => {
    expect(
      isReconciliationMessage({
        ...MESSAGE,
        mode: "MANUAL",
        requestedById: "a1b2c3__mem_01JBXQ3ZK8N4P2VYR6",
      }),
    ).toBe(true);
  });

  it("kind が違えば拒む", () => {
    expect(isReconciliationMessage({ ...MESSAGE, kind: "BASELINE_LEARNING" })).toBe(false);
  });

  it("欠けた欄があれば拒む", () => {
    const rest: Record<string, unknown> = { ...MESSAGE };
    delete rest["businessDate"];
    expect(isReconciliationMessage(rest)).toBe(false);
  });

  it("mode が語彙の外なら拒む", () => {
    expect(isReconciliationMessage({ ...MESSAGE, mode: "NIGHTLY" })).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isReconciliationMessage(null)).toBe(false);
    expect(isReconciliationMessage("RECONCILIATION")).toBe(false);
  });
});

describe("saleStatusOf — DB の 2 値を engine の 3 値へ（DECISIONS #112）", () => {
  it("販売中はそのまま", () => {
    expect(saleStatusOf("AVAILABLE", "DIRTY")).toBe("ON_SALE");
    expect(saleStatusOf("AVAILABLE", "READY")).toBe("ON_SALE");
  });

  it("売止めは OUT_OF_ORDER（§4.1 で抑制される）", () => {
    expect(saleStatusOf("OUT_OF_ORDER", "READY")).toBe("OUT_OF_ORDER");
  });

  it("清掃ステータスが BLOCKED なら MAINTENANCE として渡す", () => {
    expect(saleStatusOf("AVAILABLE", "BLOCKED")).toBe("MAINTENANCE");
  });

  it("売止めが BLOCKED より先に立つ（どちらも抑制されるので結論は同じ）", () => {
    expect(saleStatusOf("OUT_OF_ORDER", "BLOCKED")).toBe("OUT_OF_ORDER");
  });
});

describe("falsePositiveCountsOf — §4.2 の直近 30 日", () => {
  const ROOM = "a1b2c3__room_01JBXQ3ZK8N4P2VYR6";
  const OTHER_ROOM = "a1b2c3__room_01JBXQ3ZK8N4P2VYR7";

  it("その客室のぶんを数える", () => {
    const counts = falsePositiveCountsOf(
      [
        { roomId: ROOM, ruleCode: "R001" },
        { roomId: ROOM, ruleCode: "R001" },
        { roomId: ROOM, ruleCode: "R006" },
      ],
      ROOM,
    );
    expect(counts).toEqual({ R001: 2, R006: 1 });
  });

  it("別の客室のぶんは数えない", () => {
    const counts = falsePositiveCountsOf([{ roomId: OTHER_ROOM, ruleCode: "R001" }], ROOM);
    expect(counts).toEqual({});
  });

  it("施設全体として記録された行はどの客室にも効く", () => {
    const counts = falsePositiveCountsOf([{ roomId: null, ruleCode: "R001" }], ROOM);
    expect(counts).toEqual({ R001: 1 });
  });

  it("客室ぶんと施設ぶんを足し合わせる", () => {
    const counts = falsePositiveCountsOf(
      [
        { roomId: null, ruleCode: "R001" },
        { roomId: ROOM, ruleCode: "R001" },
        { roomId: OTHER_ROOM, ruleCode: "R001" },
      ],
      ROOM,
    );
    // §4.2 は 3 件以上で 1 段階下げる。**別の客室のぶんで下げない。**
    expect(counts).toEqual({ R001: 2 });
  });

  it("記録が無ければ空", () => {
    expect(falsePositiveCountsOf([], ROOM)).toEqual({});
  });
});

describe("daysBetween — 運用開始からの日数（§4.2 / OPEN_QUESTIONS #063）", () => {
  it("丸 1 日で 1", () => {
    expect(
      daysBetween(new Date("2026-09-08T00:00:00Z"), new Date("2026-09-09T00:00:00Z")),
    ).toBe(1);
  });

  it("端数は切り捨てる", () => {
    expect(
      daysBetween(new Date("2026-09-08T00:00:00Z"), new Date("2026-09-09T23:59:59Z")),
    ).toBe(1);
  });

  it("作成日より前の時刻でも負にならない", () => {
    expect(
      daysBetween(new Date("2026-09-10T00:00:00Z"), new Date("2026-09-09T00:00:00Z")),
    ).toBe(0);
  });

  it("60 日を跨ぐと §4.2 の −10 が外れる境目になる", () => {
    expect(
      daysBetween(new Date("2026-07-11T00:00:00Z"), new Date("2026-09-09T00:00:00Z")),
    ).toBe(60);
  });
});
