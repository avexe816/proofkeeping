/**
 * 期限切れによる配分停止（P8-02 / PK-SPEC-P8 §1.4 MUST）。
 *
 * > 期限切れ時、そのスタッフへの新規タスク配分を自動停止する。
 * > 既存の未完了タスクは残す（現場を止めないため）。
 *
 * ── ここが見るのは 4 つ ─────────────────────────────────
 *   1. 自動配分の候補から外れる（`previewAutoAssignment()`）
 *   2. 手動でも新しく配れない（`applyAssignments()` が黙って書かない）
 *   3. **担当を外す側は通る**（期限切れの人からタスクを剥がせる）
 *   4. 既存の割当は剥がされない（盤面から人が消えない）
 */

import type { Env, TenantContext } from "@pk/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listTasks = vi.fn();
const listRooms = vi.fn();
const listFloors = vi.fn();
const listPropertyStaff = vi.fn();
const findPropertyById = vi.fn();
const assignTasks = vi.fn();
const recordAudit = vi.fn();
const listAssignmentBlockedMembershipIds = vi.fn();

vi.mock("@pk/db", async (importOriginal) => ({
  // `NotFoundError` などの実体はそのまま使う。
  ...(await importOriginal<typeof import("@pk/db")>()),
  listTasks: (...args: unknown[]) => listTasks(...args) as unknown,
  listRooms: (...args: unknown[]) => listRooms(...args) as unknown,
  listFloors: (...args: unknown[]) => listFloors(...args) as unknown,
  listPropertyStaff: (...args: unknown[]) => listPropertyStaff(...args) as unknown,
  findPropertyById: (...args: unknown[]) => findPropertyById(...args) as unknown,
  assignTasks: (...args: unknown[]) => assignTasks(...args) as unknown,
  recordAudit: (...args: unknown[]) => recordAudit(...args) as unknown,
}));

vi.mock("../staff/assignmentBlock.js", () => ({
  listAssignmentBlockedMembershipIds: (...args: unknown[]) =>
    listAssignmentBlockedMembershipIds(...args) as unknown,
}));

const { applyAssignments, previewAutoAssignment } = await import("./assign.js");

const ENV = {} as unknown as Env;
const ORG = "a1b2c3";
const PROPERTY = `${ORG}__prop_01JBXQ3ZK8N4P2VYR60000`;
const BLOCKED = `${ORG}__mem_01JBXQ3ZK8N4P2VYR6BLOCKED0`;
const NORMAL = `${ORG}__mem_01JBXQ3ZK8N4P2VYR6NORMAL00`;
const ACTOR = `${ORG}__mem_01JBXQ3ZK8N4P2VYR6ACTOR000`;

const TENANT: TenantContext = {
  organizationId: "org_test_alpha",
  orgShortId: ORG,
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: new Date("2026-08-20T00:00:00.000Z"),
};

function taskRow(id: string, assigneeId: string | null = null) {
  return {
    id,
    propertyId: PROPERTY,
    roomId: `${ORG}__room_01JBXQ3ZK8N4P2VYR60000`,
    businessDate: "2026-08-20",
    status: "CREATED",
    assigneeId,
    priority: 0,
    standardMinutes: 30,
  };
}

function staffRow(membershipId: string) {
  return {
    membershipId,
    userId: `${ORG}__usr_01JBXQ3ZK8N4P2VYR60000`,
    role: "CLEANER" as const,
    staffNumber: "011",
    displayName: "テスト",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  assignTasks.mockImplementation((_env, _ctx, taskIds: string[]) =>
    Promise.resolve(taskIds.length),
  );
  recordAudit.mockResolvedValue(undefined);
});

describe("previewAutoAssignment — 候補から外す", () => {
  it("期限切れのスタッフへ配らない", () => {
    const board = {
      propertyId: PROPERTY,
      businessDate: "2026-08-20",
      staff: [staffRow(BLOCKED), staffRow(NORMAL)],
      tasks: [
        {
          taskId: `${ORG}__task_A`,
          roomNumber: "101",
          floorOrder: null,
          priority: 0,
          standardMinutes: 30,
          status: "CREATED" as const,
          assigneeId: null,
        },
      ],
      loads: [],
      unassigned: { taskCount: 1, minutes: 30 },
      limitMinutes: 480,
      blockedMembershipIds: [BLOCKED],
      traits: [],
    };

    const plan = previewAutoAssignment(board);

    expect(plan.pairs).toHaveLength(1);
    expect(plan.pairs[0]?.membershipId).toBe(NORMAL);
  });

  it("全員が期限切れなら未割当のまま返す（**例外にしない**）", () => {
    const board = {
      propertyId: PROPERTY,
      businessDate: "2026-08-20",
      staff: [staffRow(BLOCKED)],
      tasks: [
        {
          taskId: `${ORG}__task_A`,
          roomNumber: "101",
          floorOrder: null,
          priority: 0,
          standardMinutes: 30,
          status: "CREATED" as const,
          assigneeId: null,
        },
      ],
      loads: [],
      unassigned: { taskCount: 1, minutes: 30 },
      limitMinutes: 480,
      blockedMembershipIds: [BLOCKED],
      traits: [],
    };

    const plan = previewAutoAssignment(board);

    expect(plan.pairs).toHaveLength(0);
    expect(plan.unassignedTaskIds).toEqual([`${ORG}__task_A`]);
  });
});

describe("applyAssignments — 手動でも配れない", () => {
  it("期限切れのスタッフ宛ての組み合わせを黙って書かない", async () => {
    listTasks.mockResolvedValue([taskRow(`${ORG}__task_A`)]);
    listPropertyStaff.mockResolvedValue([staffRow(BLOCKED), staffRow(NORMAL)]);
    listAssignmentBlockedMembershipIds.mockResolvedValue(new Set([BLOCKED]));

    const result = await applyAssignments(ENV, TENANT, {
      propertyId: PROPERTY,
      businessDate: "2026-08-20",
      pairs: [{ taskId: `${ORG}__task_A`, membershipId: BLOCKED }],
      actorId: ACTOR,
    });

    expect(result.applied).toBe(0);
    expect(result.blockedTaskIds).toEqual([`${ORG}__task_A`]);
    expect(assignTasks).not.toHaveBeenCalled();
    // 書いていないので監査ログも無い。
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("**担当を外す側は通る**（期限切れの人からタスクを剥がせる）", async () => {
    listTasks.mockResolvedValue([taskRow(`${ORG}__task_A`, BLOCKED)]);
    listPropertyStaff.mockResolvedValue([staffRow(BLOCKED), staffRow(NORMAL)]);
    listAssignmentBlockedMembershipIds.mockResolvedValue(new Set([BLOCKED]));

    const result = await applyAssignments(ENV, TENANT, {
      propertyId: PROPERTY,
      businessDate: "2026-08-20",
      pairs: [{ taskId: `${ORG}__task_A`, membershipId: null }],
      actorId: ACTOR,
    });

    expect(result.applied).toBe(1);
    expect(result.blockedTaskIds).toEqual([]);
  });

  it("期限切れでないスタッフへは従来どおり配れる", async () => {
    listTasks.mockResolvedValue([taskRow(`${ORG}__task_A`)]);
    listPropertyStaff.mockResolvedValue([staffRow(NORMAL)]);
    listAssignmentBlockedMembershipIds.mockResolvedValue(new Set());

    const result = await applyAssignments(ENV, TENANT, {
      propertyId: PROPERTY,
      businessDate: "2026-08-20",
      pairs: [{ taskId: `${ORG}__task_A`, membershipId: NORMAL }],
      actorId: ACTOR,
    });

    expect(result.applied).toBe(1);
    expect(result.blockedTaskIds).toEqual([]);
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it("**判定は適用の時点で引き直す**（クライアントの盤面を信じない）", async () => {
    listTasks.mockResolvedValue([taskRow(`${ORG}__task_A`)]);
    listPropertyStaff.mockResolvedValue([staffRow(BLOCKED)]);
    listAssignmentBlockedMembershipIds.mockResolvedValue(new Set([BLOCKED]));

    await applyAssignments(ENV, TENANT, {
      propertyId: PROPERTY,
      businessDate: "2026-08-20",
      pairs: [{ taskId: `${ORG}__task_A`, membershipId: BLOCKED }],
      actorId: ACTOR,
    });

    // プレビューが古くても、適用がその日の業務日で判定し直している。
    expect(listAssignmentBlockedMembershipIds).toHaveBeenCalledWith(ENV, TENANT, "2026-08-20");
  });
});
