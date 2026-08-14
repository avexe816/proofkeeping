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
  baselinesFor,
  checkOutBusinessDateOf,
  daysBetween,
  falsePositiveCountsOf,
  isReconciliationMessage,
  localHourOf,
  occupancyRevocationsOf,
  revocationFor,
  saleStatusOf,
  statusOverridesOf,
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

// ────────────────────────────────────────────────────────────
// P4-11 / P4-12 が足した事実の組み立て
// ────────────────────────────────────────────────────────────

describe("localHourOf — 深夜帯の判定に渡す地域時刻（§3.3 / §3.9）", () => {
  it("UTC の値を施設の地域時刻へ直す", () => {
    // 2026-09-09 17:30 UTC = 翌 02:30 JST。**深夜帯に入る。**
    expect(localHourOf(new Date("2026-09-09T17:30:00Z"), "Asia/Tokyo")).toBe(2);
  });

  it("日中はそのまま", () => {
    expect(localHourOf(new Date("2026-09-09T05:00:00Z"), "Asia/Tokyo")).toBe(14);
  });

  it("時差の違う施設では別の時になる", () => {
    const at = new Date("2026-09-09T17:30:00Z");
    expect(localHourOf(at, "Asia/Tokyo")).not.toBe(localHourOf(at, "UTC"));
  });

  it("0 時台を 0 として返す（null と混ぜない）", () => {
    expect(localHourOf(new Date("2026-09-09T15:30:00Z"), "Asia/Tokyo")).toBe(0);
  });
});

describe("baselinesFor — 客室タイプ × 人数 × 作業種別（§3.4）", () => {
  const bathTowel = {
    roomTypeId: "RT1",
    guestCount: 2,
    taskType: "CHECKOUT",
    itemCode: "BATH_TOWEL",
    sampleSize: 60,
    medianQty: 2,
    p90Qty: 3,
    manualOverride: null as number | null,
    isReliable: true,
  };

  const rows = [
    bathTowel,
    {
      roomTypeId: "RT1",
      guestCount: 1,
      taskType: "CHECKOUT",
      itemCode: "BATH_TOWEL",
      sampleSize: 60,
      medianQty: 1,
      p90Qty: 2,
      manualOverride: null,
      isReliable: true,
    },
    {
      roomTypeId: "RT1",
      guestCount: 2,
      taskType: "CHECKOUT",
      itemCode: "FACE_TOWEL",
      sampleSize: 25,
      medianQty: 2,
      p90Qty: 3,
      manualOverride: null,
      isReliable: false,
    },
  ];

  it("一致する組み合わせだけを返す", () => {
    const found = baselinesFor(rows, { roomTypeId: "RT1", guestCount: 2, taskType: "CHECKOUT" });
    expect(found.map((row) => row.itemCode)).toEqual(["BATH_TOWEL"]);
  });

  it("**信頼できない統計を engine へ渡さない**（PK-SPEC-P3 §2.4 MUST）", () => {
    const found = baselinesFor(rows, { roomTypeId: "RT1", guestCount: 2, taskType: "CHECKOUT" });
    expect(found.every((row) => row.isReliable)).toBe(true);
  });

  it("手動上書きがあれば p90 として使う（同 §5.5）", () => {
    const overridden = baselinesFor([{ ...bathTowel, manualOverride: 9 }], {
      roomTypeId: "RT1",
      guestCount: 2,
      taskType: "CHECKOUT",
    });
    expect(overridden[0]?.p90Qty).toBe(9);
  });

  it("人数が分からなければ空（別の人数の基準を当てない）", () => {
    expect(
      baselinesFor(rows, { roomTypeId: "RT1", guestCount: null, taskType: "CHECKOUT" }),
    ).toEqual([]);
  });

  it("作業種別が分からなければ空", () => {
    expect(baselinesFor(rows, { roomTypeId: "RT1", guestCount: 2, taskType: null })).toEqual([]);
  });

  it("客室タイプが未設定なら空", () => {
    expect(baselinesFor(rows, { roomTypeId: "", guestCount: 2, taskType: "CHECKOUT" })).toEqual([]);
  });
});

describe("statusOverridesOf — 監査ログから上書きを取り出す（§3.8）", () => {
  const AT = new Date("2026-09-08T01:00:00Z");

  it("`room.statusOverridden` だけを拾う", () => {
    const rows = statusOverridesOf([
      {
        actorId: "MEM1",
        action: "room.statusOverridden",
        targetId: "ROOM1",
        after: JSON.stringify({ housekeepingStatus: "READY" }),
        at: AT,
      },
      {
        actorId: "MEM1",
        action: "task.completed",
        targetId: "TASK1",
        after: JSON.stringify({ housekeepingStatus: "READY" }),
        at: AT,
      },
    ]);
    expect(rows).toEqual([
      { roomId: "ROOM1", actorId: "MEM1", at: AT.getTime(), toStatus: "READY" },
    ]);
  });

  it("形が読めない行は落とす（照合を止めない）", () => {
    expect(
      statusOverridesOf([
        { actorId: "MEM1", action: "room.statusOverridden", targetId: "ROOM1", after: "{", at: AT },
        {
          actorId: "MEM1",
          action: "room.statusOverridden",
          targetId: null,
          after: JSON.stringify({ housekeepingStatus: "READY" }),
          at: AT,
        },
        { actorId: "MEM1", action: "room.statusOverridden", targetId: "ROOM1", after: null, at: AT },
      ]),
    ).toEqual([]);
  });

  it("空なら空", () => {
    expect(statusOverridesOf([])).toEqual([]);
  });
});

describe("occupancyRevocationsOf — 稼働記録の取消（§3.10）", () => {
  const AT = new Date("2026-09-10T02:14:00Z");

  function importRow(changes: unknown, businessDate = "2026-09-09") {
    return {
      actorId: "MEM1",
      action: "occupancy.imported",
      targetId: "PROP1",
      after: JSON.stringify({ businessDate, changes }),
      at: AT,
    };
  }

  it("`isOccupied` の true → false だけを拾う", () => {
    const revoked = occupancyRevocationsOf(
      [importRow([{ roomId: "ROOM1", field: "isOccupied", before: true, after: false }])],
      "2026-09-09",
    );
    expect(revoked.get("ROOM1")).toBe(AT.getTime());
  });

  it("false → true は拾わない（取消ではない）", () => {
    const revoked = occupancyRevocationsOf(
      [importRow([{ roomId: "ROOM1", field: "isOccupied", before: false, after: true }])],
      "2026-09-09",
    );
    expect(revoked.size).toBe(0);
  });

  it("他の項目の変更は拾わない", () => {
    const revoked = occupancyRevocationsOf(
      [importRow([{ roomId: "ROOM1", field: "guestCount", before: 2, after: 0 }])],
      "2026-09-09",
    );
    expect(revoked.size).toBe(0);
  });

  it("**別の業務日の取込は拾わない**", () => {
    const revoked = occupancyRevocationsOf(
      [
        importRow(
          [{ roomId: "ROOM1", field: "isOccupied", before: true, after: false }],
          "2026-09-01",
        ),
      ],
      "2026-09-09",
    );
    expect(revoked.size).toBe(0);
  });

  it("壊れた payload は落とす", () => {
    expect(
      occupancyRevocationsOf(
        [
          { actorId: "M", action: "occupancy.imported", targetId: "P", after: "{", at: AT },
          importRow("not-an-array"),
        ],
        "2026-09-09",
      ).size,
    ).toBe(0);
  });
});

describe("revocationFor — engine へ渡す形", () => {
  it("清掃完了時刻があれば組み立てる", () => {
    const map = new Map([["ROOM1", 200]]);
    expect(revocationFor(map, "ROOM1", 100)).toEqual({ at: 200, cleaningCompletedAt: 100 });
  });

  it("**清掃が完了していなければ null**（「後」を判定できない）", () => {
    expect(revocationFor(new Map([["ROOM1", 200]]), "ROOM1", null)).toBeNull();
  });

  it("取消が無ければ null", () => {
    expect(revocationFor(new Map(), "ROOM1", 100)).toBeNull();
  });
});

describe("checkOutBusinessDateOf — 退室時刻を業務日へ（§3.5）", () => {
  const PROPERTY = { timezone: "Asia/Tokyo", dayCutoffTime: "05:00" };

  it("日締め後の退室は当日", () => {
    const at = Date.parse("2026-09-05T11:00:00+09:00");
    expect(checkOutBusinessDateOf({ checkOutAt: at } as never, PROPERTY)).toBe("2026-09-05");
  });

  it("日締め前の退室は前日扱い", () => {
    const at = Date.parse("2026-09-05T03:00:00+09:00");
    expect(checkOutBusinessDateOf({ checkOutAt: at } as never, PROPERTY)).toBe("2026-09-04");
  });

  it("退室の記録が無ければ null", () => {
    expect(checkOutBusinessDateOf({ checkOutAt: null } as never, PROPERTY)).toBeNull();
    expect(checkOutBusinessDateOf(null, PROPERTY)).toBeNull();
  });
});
