/**
 * 人員配分（P1-14 / PK-SPEC-P1 §4）。
 *
 * ルール: .claude/rules/testing.md §3（正例と負例を最低 5 件ずつ）
 */

import { describe, expect, it } from "vitest";

import {
  WORKLOAD_LIMIT_MINUTES,
  isAssignable,
  planAutoAssignment,
  sortTasksForAssignment,
  summarizeUnassigned,
  summarizeWorkload,
  type AssignableStaff,
  type AssignableTask,
} from "./assignment.js";

function task(partial: Partial<AssignableTask> & { taskId: string }): AssignableTask {
  return {
    roomNumber: "301",
    floorOrder: 3,
    priority: 50,
    standardMinutes: 40,
    status: "CREATED",
    assigneeId: null,
    ...partial,
  };
}

const STAFF: readonly AssignableStaff[] = [
  { membershipId: "m_b", staffNumber: "08" },
  { membershipId: "m_a", staffNumber: "03" },
];

describe("sortTasksForAssignment — §4.1 の 1", () => {
  it("priority 昇順が最優先", () => {
    const sorted = sortTasksForAssignment([
      task({ taskId: "t1", priority: 50, roomNumber: "301" }),
      task({ taskId: "t2", priority: 10, roomNumber: "902" }),
    ]);
    expect(sorted.map((row) => row.taskId)).toEqual(["t2", "t1"]);
  });

  it("同じ priority なら階順", () => {
    const sorted = sortTasksForAssignment([
      task({ taskId: "t1", floorOrder: 5, roomNumber: "501" }),
      task({ taskId: "t2", floorOrder: 3, roomNumber: "302" }),
    ]);
    expect(sorted.map((row) => row.taskId)).toEqual(["t2", "t1"]);
  });

  it("同じ階なら客室番号（辞書順ではなく数値）", () => {
    const sorted = sortTasksForAssignment([
      task({ taskId: "t1", roomNumber: "1002" }),
      task({ taskId: "t2", roomNumber: "302" }),
    ]);
    expect(sorted.map((row) => row.taskId)).toEqual(["t2", "t1"]);
  });

  it("階が未登録の客室は最後へ回す", () => {
    const sorted = sortTasksForAssignment([
      task({ taskId: "lobby", floorOrder: null, roomNumber: "LOBBY" }),
      task({ taskId: "t2", floorOrder: 9, roomNumber: "901" }),
    ]);
    expect(sorted.map((row) => row.taskId)).toEqual(["t2", "lobby"]);
  });

  it("入力を書き換えない", () => {
    const input = [task({ taskId: "t1", priority: 90 }), task({ taskId: "t2", priority: 10 })];
    sortTasksForAssignment(input);
    expect(input.map((row) => row.taskId)).toEqual(["t1", "t2"]);
  });
});

describe("planAutoAssignment — §4.1 の 3〜5", () => {
  it("ラウンドロビンで配る", () => {
    const plan = planAutoAssignment(
      [
        task({ taskId: "t1", roomNumber: "301" }),
        task({ taskId: "t2", roomNumber: "302" }),
        task({ taskId: "t3", roomNumber: "303" }),
      ],
      STAFF,
    );
    // スタッフ番号昇順（03 → 08）で回る。
    expect(plan.assignments).toEqual([
      { taskId: "t1", membershipId: "m_a" },
      { taskId: "t2", membershipId: "m_b" },
      { taskId: "t3", membershipId: "m_a" },
    ]);
  });

  it("上限を超えるなら次の人へ回す", () => {
    const plan = planAutoAssignment(
      [
        task({ taskId: "t1", standardMinutes: 400, roomNumber: "301" }),
        task({ taskId: "t2", standardMinutes: 400, roomNumber: "302" }),
      ],
      STAFF,
    );
    expect(new Set(plan.assignments.map((row) => row.membershipId)).size).toBe(2);
  });

  it("全員が上限なら未割当のまま残す（§4.1 の 5）", () => {
    const plan = planAutoAssignment(
      [
        task({ taskId: "t1", standardMinutes: 400, roomNumber: "301" }),
        task({ taskId: "t2", standardMinutes: 400, roomNumber: "302" }),
        task({ taskId: "t3", standardMinutes: 400, roomNumber: "303" }),
      ],
      STAFF,
    );
    expect(plan.assignments).toHaveLength(2);
    expect(plan.unassignedTaskIds).toEqual(["t3"]);
  });

  it("既存の割当を消さない", () => {
    const plan = planAutoAssignment(
      [
        task({ taskId: "kept", assigneeId: "m_a", status: "ASSIGNED" }),
        task({ taskId: "new", roomNumber: "302" }),
      ],
      STAFF,
    );
    expect(plan.assignments.map((row) => row.taskId)).toEqual(["new"]);
  });

  it("既存の負荷を織り込んでから配る", () => {
    const plan = planAutoAssignment(
      [
        task({ taskId: "kept", assigneeId: "m_a", status: "ASSIGNED", standardMinutes: 410 }),
        task({ taskId: "new", roomNumber: "302", standardMinutes: 30 }),
      ],
      STAFF,
    );
    // m_a は既に 410 分。30 分を足すと上限を超えるので m_b へ。
    expect(plan.assignments).toEqual([{ taskId: "new", membershipId: "m_b" }]);
  });

  it("スタッフが 1 人も居なければ全件が未割当", () => {
    const plan = planAutoAssignment([task({ taskId: "t1" })], []);
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassignedTaskIds).toEqual(["t1"]);
  });
});

describe("planAutoAssignment — 触らないもの（負例）", () => {
  it("作業中のタスクを配り直さない", () => {
    const plan = planAutoAssignment([task({ taskId: "t1", status: "IN_PROGRESS" })], STAFF);
    expect(plan.assignments).toHaveLength(0);
  });

  it("完了したタスクを配らない", () => {
    const plan = planAutoAssignment([task({ taskId: "t1", status: "COMPLETED" })], STAFF);
    expect(plan.assignments).toHaveLength(0);
  });

  it("取消したタスクを配らない", () => {
    const plan = planAutoAssignment([task({ taskId: "t1", status: "CANCELLED" })], STAFF);
    expect(plan.assignments).toHaveLength(0);
  });

  it("入室不可のタスクを配らない", () => {
    const plan = planAutoAssignment([task({ taskId: "t1", status: "BLOCKED" })], STAFF);
    expect(plan.assignments).toHaveLength(0);
  });

  it("isAssignable は未着手だけを真にする", () => {
    expect(isAssignable("CREATED")).toBe(true);
    expect(isAssignable("ASSIGNED")).toBe(true);
    expect(isAssignable("IN_PROGRESS")).toBe(false);
    expect(isAssignable("COMPLETED")).toBe(false);
    expect(isAssignable("CANCELLED")).toBe(false);
  });

  it("3 回実行しても結果が変わらない（testing.md §4）", () => {
    const tasks = [
      task({ taskId: "t1", roomNumber: "301" }),
      task({ taskId: "t2", roomNumber: "302" }),
    ];
    const first = planAutoAssignment(tasks, STAFF);
    expect(planAutoAssignment(tasks, STAFF)).toEqual(first);
    expect(planAutoAssignment(tasks, STAFF)).toEqual(first);
  });
});

describe("planAutoAssignment — スキルと難易度（P8-04 / §1.7）", () => {
  const CHECKOUT = task({ taskId: "t1", taskType: "CHECKOUT" });
  const DEEP = task({ taskId: "t2", taskType: "DEEP" });

  // ── 正例 ──────────────────────────────────────────────

  it("スキルに合う人へ割り当たる", () => {
    const plan = planAutoAssignment(
      [CHECKOUT],
      [{ membershipId: "m_a", staffNumber: "01", skills: ["CHECKOUT"] }],
    );
    expect(plan.assignments).toEqual([{ taskId: "t1", membershipId: "m_a" }]);
  });

  it("スキル外の人を飛ばして、できる人へ回る", () => {
    const plan = planAutoAssignment(
      [DEEP],
      [
        { membershipId: "m_a", staffNumber: "01", skills: ["CHECKOUT"] },
        { membershipId: "m_b", staffNumber: "02", skills: ["DEEP"] },
      ],
    );
    expect(plan.assignments).toEqual([{ taskId: "t2", membershipId: "m_b" }]);
  });

  it("**スキル未登録（空）は制約なし**（未入力の組織で従来どおり動く）", () => {
    const plan = planAutoAssignment(
      [DEEP],
      [{ membershipId: "m_a", staffNumber: "01", skills: [] }],
    );
    expect(plan.assignments).toHaveLength(1);
  });

  it("スキルを渡さなければ従来どおり（後方互換）", () => {
    const plan = planAutoAssignment([DEEP], [{ membershipId: "m_a", staffNumber: "01" }]);
    expect(plan.assignments).toHaveLength(1);
  });

  it("taskType の無いタスクは誰にでも割り当たる", () => {
    const plan = planAutoAssignment(
      [task({ taskId: "t3" })],
      [{ membershipId: "m_a", staffNumber: "01", skills: ["CHECKOUT"] }],
    );
    expect(plan.assignments).toHaveLength(1);
  });

  // ── 負例 ──────────────────────────────────────────────

  it("**全員がスキル外なら未割当のまま残す**（無資格に詰め込まない）", () => {
    const plan = planAutoAssignment(
      [DEEP],
      [{ membershipId: "m_a", staffNumber: "01", skills: ["CHECKOUT", "STAYOVER"] }],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassignedTaskIds).toEqual(["t2"]);
  });

  it("1 年目（avoidHardTasks）に特別清掃を割り当てない", () => {
    const plan = planAutoAssignment(
      [DEEP],
      [
        { membershipId: "m_new", staffNumber: "01", avoidHardTasks: true },
        { membershipId: "m_vet", staffNumber: "02" },
      ],
    );
    expect(plan.assignments).toEqual([{ taskId: "t2", membershipId: "m_vet" }]);
  });

  it("1 年目でも通常清掃は受け持てる", () => {
    const plan = planAutoAssignment(
      [CHECKOUT],
      [{ membershipId: "m_new", staffNumber: "01", avoidHardTasks: true }],
    );
    expect(plan.assignments).toHaveLength(1);
  });

  it("高難度の語彙を差し替えられる（既定は DEEP だけ）", () => {
    const plan = planAutoAssignment(
      [CHECKOUT],
      [{ membershipId: "m_new", staffNumber: "01", avoidHardTasks: true }],
      480,
      ["CHECKOUT"],
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassignedTaskIds).toEqual(["t1"]);
  });

  it("スキル外を飛ばしても**負荷の上限は守る**（先にスキルを見る）", () => {
    // m_a はスキル外、m_b は上限ぎりぎり。詰め込まず未割当に残す。
    const heavy = task({ taskId: "t4", taskType: "DEEP", standardMinutes: 60 });
    const plan = planAutoAssignment(
      [heavy],
      [
        { membershipId: "m_a", staffNumber: "01", skills: ["CHECKOUT"] },
        { membershipId: "m_b", staffNumber: "02", skills: ["DEEP"] },
      ],
      30,
    );
    expect(plan.assignments).toHaveLength(0);
    expect(plan.unassignedTaskIds).toEqual(["t4"]);
  });
});

describe("summarizeWorkload — §4.3", () => {
  it("割当済みだけを数える", () => {
    const rows = summarizeWorkload(
      [
        task({ taskId: "t1", assigneeId: "m_a", standardMinutes: 40 }),
        task({ taskId: "t2", assigneeId: null, standardMinutes: 40 }),
      ],
      STAFF,
    );
    expect(rows.find((row) => row.membershipId === "m_a")?.minutes).toBe(40);
  });

  it("取消したタスクを数えない", () => {
    const rows = summarizeWorkload(
      [task({ taskId: "t1", assigneeId: "m_a", status: "CANCELLED", standardMinutes: 40 })],
      STAFF,
    );
    expect(rows.find((row) => row.membershipId === "m_a")?.minutes).toBe(0);
  });

  it("上限ちょうどは超過にしない", () => {
    const rows = summarizeWorkload(
      [task({ taskId: "t1", assigneeId: "m_a", standardMinutes: WORKLOAD_LIMIT_MINUTES })],
      STAFF,
    );
    expect(rows.find((row) => row.membershipId === "m_a")?.overLimit).toBe(false);
  });

  it("上限を 1 分超えたら超過", () => {
    const rows = summarizeWorkload(
      [task({ taskId: "t1", assigneeId: "m_a", standardMinutes: WORKLOAD_LIMIT_MINUTES + 1 })],
      STAFF,
    );
    expect(rows.find((row) => row.membershipId === "m_a")?.overLimit).toBe(true);
  });

  it("一覧に居ないスタッフの割当も落とさない", () => {
    const rows = summarizeWorkload([task({ taskId: "t1", assigneeId: "m_gone" })], STAFF);
    expect(rows.find((row) => row.membershipId === "m_gone")?.taskCount).toBe(1);
  });

  it("割当が 1 件も無くても全員を 0 で返す", () => {
    expect(summarizeWorkload([], STAFF)).toHaveLength(2);
  });
});

describe("summarizeUnassigned", () => {
  it("未割当の件数と分を返す", () => {
    expect(
      summarizeUnassigned([
        task({ taskId: "t1", standardMinutes: 40 }),
        task({ taskId: "t2", standardMinutes: 80 }),
        task({ taskId: "t3", assigneeId: "m_a" }),
      ]),
    ).toEqual({ taskCount: 2, minutes: 120 });
  });

  it("取消したタスクを含めない", () => {
    expect(
      summarizeUnassigned([task({ taskId: "t1", status: "CANCELLED", standardMinutes: 40 })]),
    ).toEqual({ taskCount: 0, minutes: 0 });
  });
});
