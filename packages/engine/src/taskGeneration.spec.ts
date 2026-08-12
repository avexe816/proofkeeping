/**
 * §3.1 の生成ルールと §3.3 の差分生成。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）/ §4（冪等）
 * task:  docs/tasks/P1-03.md
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_STANDARD_MINUTES,
  TASK_PRIORITY,
  determineTask,
  planGeneration,
  type ExistingTask,
  type RoomPlanInput,
} from "./taskGeneration.js";

/** 既定の 1 行。個々のテストが必要な項目だけを上書きする。 */
function plan(overrides: Partial<RoomPlanInput> = {}): RoomPlanInput {
  return {
    roomId: "o7k2m9__room_01JBXQ3ZK8N4P2VYR60000",
    hasCheckout: false,
    hasCheckin: false,
    isStayover: false,
    declineClean: false,
    roomTypeId: null,
    ...overrides,
  };
}

describe("determineTask — 正例（§3.1 の表）", () => {
  it("checkout ○ / checkin ○ は CHECKOUT を優先度 10 で作る", () => {
    const task = determineTask(plan({ hasCheckout: true, hasCheckin: true }));

    expect(task?.taskType).toBe("CHECKOUT");
    expect(task?.priority).toBe(TASK_PRIORITY.checkoutWithCheckin);
    expect(task?.standardMinutes).toBe(40);
  });

  it("checkout ○ / checkin × は CHECKOUT を優先度 40 で作る", () => {
    const task = determineTask(plan({ hasCheckout: true }));

    expect(task?.taskType).toBe("CHECKOUT");
    expect(task?.priority).toBe(TASK_PRIORITY.checkoutOnly);
  });

  it("stayover ○ / declineClean × は STAYOVER を優先度 60 で作る", () => {
    const task = determineTask(plan({ isStayover: true }));

    expect(task?.taskType).toBe("STAYOVER");
    expect(task?.priority).toBe(TASK_PRIORITY.stayover);
    expect(task?.standardMinutes).toBe(20);
  });

  it("空室 3 日以上は RECHECK を優先度 80 で作る", () => {
    const task = determineTask(plan({ vacantDays: 3 }));

    expect(task?.taskType).toBe("RECHECK");
    expect(task?.priority).toBe(TASK_PRIORITY.recheck);
    expect(task?.standardMinutes).toBe(10);
  });

  it("standardTime に該当があれば既定分数より優先する", () => {
    const task = determineTask(plan({ hasCheckout: true, roomTypeId: "rt-twin" }), (roomTypeId) =>
      roomTypeId === "rt-twin" ? 55 : undefined,
    );

    expect(task?.standardMinutes).toBe(55);
    expect(DEFAULT_STANDARD_MINUTES.CHECKOUT).toBe(40);
  });
});

describe("determineTask — 負例（§3.1 の「生成しない」）", () => {
  it("stayover ○ / declineClean ○ は作らない", () => {
    expect(determineTask(plan({ isStayover: true, declineClean: true }))).toBeNull();
  });

  it("MAINTENANCE の客室は作らない", () => {
    expect(
      determineTask(plan({ hasCheckout: true, availability: "MAINTENANCE" })),
    ).toBeNull();
  });

  it("OUT_OF_ORDER の客室は作らない", () => {
    expect(determineTask(plan({ isStayover: true, availability: "OUT_OF_ORDER" }))).toBeNull();
  });

  it("空室日数が 2 日なら空室点検を作らない", () => {
    expect(determineTask(plan({ vacantDays: 2 }))).toBeNull();
  });

  it("空室日数が未知（undefined）なら空室点検を作らない", () => {
    // 未知を 0 で代用すると、逆に毎日点検タスクが立つ。
    expect(determineTask(plan({}))).toBeNull();
  });

  it("稼働も空室日数も無い客室は作らない", () => {
    expect(determineTask(plan({ hasCheckin: true }))).toBeNull();
  });
});

describe("determineTask — 1 客室に 2 種類を作らない", () => {
  it("checkout と stayover が同時に立っていても CHECKOUT だけを返す", () => {
    const task = determineTask(plan({ hasCheckout: true, isStayover: true }));

    expect(task?.taskType).toBe("CHECKOUT");
  });

  it("checkout ○ なら declineClean ○ でも CHECKOUT を作る", () => {
    // 清掃辞退は滞在中の意思表示。退室後の清掃を止める意味は持たない。
    const task = determineTask(plan({ hasCheckout: true, declineClean: true }));

    expect(task?.taskType).toBe("CHECKOUT");
  });
});

/** 既存タスクの 1 行。 */
function existing(overrides: Partial<ExistingTask> = {}): ExistingTask {
  return {
    roomId: "o7k2m9__room_01JBXQ3ZK8N4P2VYR60000",
    taskType: "CHECKOUT",
    status: "CREATED",
    priority: TASK_PRIORITY.checkoutOnly,
    standardMinutes: 40,
    ...overrides,
  };
}

describe("planGeneration — 差分生成（§3.3）", () => {
  it("既存が無ければ作る", () => {
    const result = planGeneration([plan({ hasCheckout: true })], []);

    expect(result.create).toHaveLength(1);
    expect(result.update).toHaveLength(0);
    expect(result.cancel).toHaveLength(0);
  });

  it("3 回続けて実行しても重複しない（冪等）", () => {
    const plans = [plan({ hasCheckout: true, hasCheckin: true })];
    const applied: ExistingTask[] = [];

    for (let round = 0; round < 3; round++) {
      const result = planGeneration(plans, applied);
      for (const task of result.create) {
        applied.push({ ...task, status: "CREATED" });
      }
      if (round > 0) {
        expect(result.create).toHaveLength(0);
        expect(result.update).toHaveLength(0);
        expect(result.cancel).toHaveLength(0);
      }
    }

    expect(applied).toHaveLength(1);
  });

  it.each(["IN_PROGRESS", "PAUSED", "AWAITING_INSPECTION", "COMPLETED", "REWORK"])(
    "着手済み（%s）のタスクは優先度が変わっても触らない",
    (status) => {
      const result = planGeneration(
        [plan({ hasCheckout: true, hasCheckin: true })],
        [existing({ status, priority: 99, standardMinutes: 5 })],
      );

      expect(result.create).toHaveLength(0);
      expect(result.update).toHaveLength(0);
      expect(result.cancel).toHaveLength(0);
    },
  );

  it("未着手なら優先度と標準時間だけを更新する", () => {
    const result = planGeneration(
      [plan({ hasCheckout: true, hasCheckin: true })],
      [existing({ status: "ASSIGNED" })],
    );

    expect(result.create).toHaveLength(0);
    expect(result.update[0]?.priority).toBe(TASK_PRIORITY.checkoutWithCheckin);
  });

  it("値が変わらない未着手タスクには UPDATE を出さない", () => {
    const result = planGeneration([plan({ hasCheckout: true })], [existing({ status: "CREATED" })]);

    expect(result.update).toHaveLength(0);
  });

  it("計画から消えた未着手タスクを取消す", () => {
    const result = planGeneration([], [existing({ status: "ASSIGNED" })]);

    expect(result.cancel).toEqual([
      { roomId: "o7k2m9__room_01JBXQ3ZK8N4P2VYR60000", taskType: "CHECKOUT" },
    ]);
  });

  it("計画から消えても着手済みなら取消さない", () => {
    const result = planGeneration([], [existing({ status: "IN_PROGRESS" })]);

    expect(result.cancel).toHaveLength(0);
  });

  it("取消済みのタスクを二重に取消さない", () => {
    const result = planGeneration([], [existing({ status: "CANCELLED" })]);

    expect(result.cancel).toHaveLength(0);
  });

  it("取消済みの客室が計画に戻ったら復活させる（新しい行を作らない）", () => {
    // 一意制約 (organizationId, roomId, businessDate, taskType) があるため
    // 作り直しは INSERT ではなく復活で行う。
    const result = planGeneration(
      [plan({ hasCheckout: true })],
      [existing({ status: "CANCELLED" })],
    );

    expect(result.create).toHaveLength(0);
    expect(result.revive).toHaveLength(1);
  });

  it("種別が変わった場合は新しい種別を作り、古い種別を取消す", () => {
    const result = planGeneration(
      [plan({ isStayover: true })],
      [existing({ status: "CREATED", taskType: "CHECKOUT" })],
    );

    expect(result.create[0]?.taskType).toBe("STAYOVER");
    expect(result.cancel[0]?.taskType).toBe("CHECKOUT");
  });

  it("100 室ぶんの計画を組み立てられる（§13 の 5 秒以内の前提）", () => {
    const plans = Array.from({ length: 100 }, (_, i) =>
      plan({ roomId: `o7k2m9__room_${String(i).padStart(26, "0")}`, hasCheckout: true }),
    );

    const result = planGeneration(plans, []);

    expect(result.create).toHaveLength(100);
  });
});
