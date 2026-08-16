/**
 * 検査キュー（施設横断 / P7-18）。
 *
 * リポジトリ層が組む SQL は `tests/tenant-isolation/inspectionQueue.spec.ts` と
 * `packages/db` 側の spec が見ている。ここが見るのは**この関数が足している
 * 判断**の 3 つ。
 *
 *   1. 自分が清掃したタスクを出さない（security.md §1）
 *   2. 担当者を応答に載せない（INV-09）
 *   3. 施設ごとの SLA で評価してから 1 本に並べる（§11.2）
 */

import type { Env, TenantContext } from "@pk/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listTasks = vi.fn();
const listRooms = vi.fn();
const listProperties = vi.fn();
const findInspectionPolicy = vi.fn();

vi.mock("@pk/db", () => ({
  listTasks: (...args: unknown[]) => listTasks(...args) as unknown,
  listRooms: (...args: unknown[]) => listRooms(...args) as unknown,
  listProperties: (...args: unknown[]) => listProperties(...args) as unknown,
  findInspectionPolicy: (...args: unknown[]) => findInspectionPolicy(...args) as unknown,
}));

const { buildInspectionQueue } = await import("./queue.js");

const ENV = {} as unknown as Env;
const NOW = new Date("2026-08-12T09:00:00.000Z");

const PROPERTY_A = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR60000";
const PROPERTY_B = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR60001";
const VIEWER = "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000";
const SOMEONE_ELSE = "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60001";

const TENANT: TenantContext = {
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: NOW,
};

/** 検査待ちのタスク 1 件。**完了時刻は「何分前か」で書く。** */
function taskRow(input: {
  id: string;
  propertyId: string;
  roomId: string;
  assigneeId: string;
  completedMinutesAgo: number;
  currentInspectionRound?: number;
}) {
  return {
    id: input.id,
    propertyId: input.propertyId,
    roomId: input.roomId,
    assigneeId: input.assigneeId,
    completedAt: new Date(NOW.getTime() - input.completedMinutesAgo * 60_000),
    currentInspectionRound: input.currentInspectionRound ?? 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listRooms.mockResolvedValue([
    { id: "room-a1", roomNumber: "101" },
    { id: "room-a2", roomNumber: "102" },
    { id: "room-b1", roomNumber: "201" },
  ]);
  listProperties.mockResolvedValue([
    { id: PROPERTY_A, name: "サンプルホテル東京" },
    { id: PROPERTY_B, name: "ビジネスH川崎" },
  ]);
  findInspectionPolicy.mockResolvedValue(undefined);
});

const SCOPE_ALL = { propertyIds: null, selectedPropertyId: null, canSelectAll: true } as const;

describe("自己検査の除外", () => {
  it("自分が清掃したタスクを一覧に出さない", async () => {
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-self",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: VIEWER,
        completedMinutesAgo: 30,
      }),
      taskRow({
        id: "t-other",
        propertyId: PROPERTY_A,
        roomId: "room-a2",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 10,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    expect(result.data.map((row) => row.taskId)).toEqual(["t-other"]);
  });

  it("除いた件は summary にも数えない", async () => {
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-self",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: VIEWER,
        completedMinutesAgo: 30,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    // **0 件になる。** 「自分のぶんを含めて 1 件」と見せない。
    expect(result.summary.total).toBe(0);
    expect(result.data).toEqual([]);
  });

  it("施設の設定に関わらず除く（緊急時の例外は開く側が持つ）", async () => {
    // `selfInspectionAllowed = true` の施設でもキューには出さない。
    findInspectionPolicy.mockResolvedValue({
      inspectionSlaMinutes: 20,
      selfInspectionAllowed: true,
    });
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-self",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: VIEWER,
        completedMinutesAgo: 30,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    expect(result.data).toEqual([]);
  });
});

describe("担当者を載せない（INV-09）", () => {
  it("応答のどの行にも担当者の値が含まれない", async () => {
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-1",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 10,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    // 列名ではなく**値**で見る。列名を変えても漏れは漏れ。
    expect(JSON.stringify(result)).not.toContain(SOMEONE_ELSE);
    expect(result.data[0]).not.toHaveProperty("assigneeId");
  });
});

describe("施設ごとの SLA", () => {
  it("施設ごとの目安で超過を判定する", async () => {
    // A は 20 分・B は 90 分。どちらも完了から 30 分経過。
    findInspectionPolicy.mockImplementation((_env: unknown, _ctx: unknown, propertyId: string) =>
      Promise.resolve(
        propertyId === PROPERTY_A
          ? { inspectionSlaMinutes: 20, selfInspectionAllowed: false }
          : { inspectionSlaMinutes: 90, selfInspectionAllowed: false },
      ),
    );
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-a",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 30,
      }),
      taskRow({
        id: "t-b",
        propertyId: PROPERTY_B,
        roomId: "room-b1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 30,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    const byId = new Map(result.data.map((row) => [row.taskId, row]));
    expect(byId.get("t-a")?.isOverSla).toBe(true);
    expect(byId.get("t-b")?.isOverSla).toBe(false);
    // 各行が自分の施設の目安を持つ（画面が「30 / 20」と出せる）。
    expect(byId.get("t-a")?.slaMinutes).toBe(20);
    expect(byId.get("t-b")?.slaMinutes).toBe(90);
  });

  it("超過した施設の行が先に来る（§11.2 の第 2 段）", async () => {
    findInspectionPolicy.mockImplementation((_env: unknown, _ctx: unknown, propertyId: string) =>
      Promise.resolve(
        propertyId === PROPERTY_A
          ? { inspectionSlaMinutes: 20, selfInspectionAllowed: false }
          : { inspectionSlaMinutes: 90, selfInspectionAllowed: false },
      ),
    );
    // **B のほうが古い。** 完了時刻だけで並べれば B が先に来るが、
    // A は自施設の目安を超えているので上の束に入る。
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-b-older",
        propertyId: PROPERTY_B,
        roomId: "room-b1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 60,
      }),
      taskRow({
        id: "t-a-over",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 30,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    expect(result.data.map((row) => row.taskId)).toEqual(["t-a-over", "t-b-older"]);
  });

  it("設定の無い施設は既定の目安を使う", async () => {
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-a",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 5,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    expect(result.data[0]?.slaMinutes).toBe(20);
  });

  it("施設の設定を施設ごとに 1 回だけ引く", async () => {
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-a1",
        propertyId: PROPERTY_A,
        roomId: "room-a1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 5,
      }),
      taskRow({
        id: "t-a2",
        propertyId: PROPERTY_A,
        roomId: "room-a2",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 6,
      }),
      taskRow({
        id: "t-b1",
        propertyId: PROPERTY_B,
        roomId: "room-b1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 7,
      }),
    ]);

    await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    // 3 タスク・2 施設 → 2 回。**タスクごとに引かない。**
    expect(findInspectionPolicy).toHaveBeenCalledTimes(2);
  });
});

describe("絞り込み", () => {
  it("施設を選んでいればその施設だけを引く", async () => {
    listTasks.mockResolvedValue([]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: { propertyIds: [PROPERTY_A], selectedPropertyId: PROPERTY_A, canSelectAll: true },
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    expect(listTasks).toHaveBeenCalledWith(ENV, TENANT, {
      businessDate: "2026-08-12",
      status: ["AWAITING_INSPECTION"],
      propertyId: PROPERTY_A,
    });
    expect(result.propertyId).toBe(PROPERTY_A);
  });

  it("検査待ち以外の状態を引かない", async () => {
    listTasks.mockResolvedValue([]);

    await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    expect(listTasks).toHaveBeenCalledWith(ENV, TENANT, {
      businessDate: "2026-08-12",
      status: ["AWAITING_INSPECTION"],
    });
  });

  it("施設名を行に添える", async () => {
    listTasks.mockResolvedValue([
      taskRow({
        id: "t-b1",
        propertyId: PROPERTY_B,
        roomId: "room-b1",
        assigneeId: SOMEONE_ELSE,
        completedMinutesAgo: 5,
      }),
    ]);

    const result = await buildInspectionQueue(ENV, TENANT, {
      scope: SCOPE_ALL,
      businessDate: "2026-08-12",
      viewerMembershipId: VIEWER,
      now: NOW,
    });

    expect(result.data[0]?.propertyName).toBe("ビジネスH川崎");
    expect(result.data[0]?.roomNumber).toBe("201");
  });
});
