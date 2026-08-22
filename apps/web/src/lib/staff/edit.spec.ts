/**
 * スタッフ詳細レイヤーの書き込みが守る境界（W-07 / 人間の指示 2026-08-22）。
 *
 * ── リポジトリ層を差し替える理由 ────────────────────────
 * ここで確かめたいのは「誰が何を触れるか」「監査ログに何を載せるか」で、
 * SQL ではない。SQL に組織条件が載ることは
 * `packages/db/src/repositories/repositories.spec.ts` が全関数について
 * 固定しているので、ここでは重ねない（`auth/login.spec.ts` と同じ流儀）。
 */

import type { Role, TenantContext } from "@pk/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findOrgStaffDetail = vi.fn();
const listStaffPropertyAssignments = vi.fn();
const recordAudit = vi.fn();
const replacePropertyAssignments = vi.fn();
const setUserActive = vi.fn();
const updateMembershipRole = vi.fn();
const updateUserProfile = vi.fn();

vi.mock("@pk/db", () => ({
  findOrgStaffDetail: (...args: unknown[]) => findOrgStaffDetail(...args) as unknown,
  listStaffPropertyAssignments: (...args: unknown[]) =>
    listStaffPropertyAssignments(...args) as unknown,
  recordAudit: (...args: unknown[]) => recordAudit(...args) as unknown,
  replacePropertyAssignments: (...args: unknown[]) =>
    replacePropertyAssignments(...args) as unknown,
  setUserActive: (...args: unknown[]) => setUserActive(...args) as unknown,
  updateMembershipRole: (...args: unknown[]) => updateMembershipRole(...args) as unknown,
  updateUserProfile: (...args: unknown[]) => updateUserProfile(...args) as unknown,
}));

const { loadStaffDetail, setStaffActive, updateStaff } = await import("./edit.js");

type Env = import("@pk/db").Env;

const ORG = { organizationId: "org_test_alpha", orgShortId: "a1b2c3" } as const;
const ACTOR = "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60000";
const TARGET = "a1b2c3__mem_01JBXQ3ZK8N4P2VYR60001";
const TARGET_USER = "a1b2c3__usr_01JBXQ3ZK8N4P2VYR60001";
const PROPERTY_A = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6000A";
const PROPERTY_B = "a1b2c3__prop_01JBXQ3ZK8N4P2VYR6000B";

const env = {} as Env;

function tenant(role: Role = "ORG_ADMIN", allowedPropertyIds: string[] = []): TenantContext {
  return {
    ...ORG,
    role,
    allowedPropertyIds,
    now: new Date("2026-08-22T00:00:00.000Z"),
  };
}

/** 対象の代役。既定は現場スタッフ（`CLEANER`）で施設 A の担当。 */
function detailRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    membershipId: TARGET,
    userId: TARGET_USER,
    role: "CLEANER",
    staffNumber: "S-0002",
    displayName: "テスト 花子",
    locale: "ja",
    email: "hanako@example.com",
    isActive: true,
    ...overrides,
  };
}

function updateForm(overrides: Record<string, string | string[]> = {}): FormData {
  const form = new FormData();
  const values: Record<string, string | string[]> = {
    membershipId: TARGET,
    displayName: "テスト 花子",
    role: "CLEANER",
    locale: "ja",
    email: "hanako@example.com",
    propertyIds: [PROPERTY_A],
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) {
    for (const entry of Array.isArray(value) ? value : [value]) form.append(name, entry);
  }
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  findOrgStaffDetail.mockResolvedValue(detailRow());
  listStaffPropertyAssignments.mockResolvedValue([
    { membershipId: TARGET, propertyId: PROPERTY_A },
  ]);
  updateUserProfile.mockResolvedValue(1);
  updateMembershipRole.mockResolvedValue(1);
  setUserActive.mockResolvedValue(1);
});

describe("loadStaffDetail", () => {
  it("`userId` を画面へ渡さない（loader の戻り値は HTML に載る）", async () => {
    const detail = await loadStaffDetail(env, tenant(), TARGET);
    expect(detail).toBeDefined();
    expect(detail).not.toHaveProperty("userId");
  });

  it("担当施設は対象の割当だけを拾う", async () => {
    listStaffPropertyAssignments.mockResolvedValue([
      { membershipId: TARGET, propertyId: PROPERTY_A },
      { membershipId: ACTOR, propertyId: PROPERTY_B },
    ]);
    const detail = await loadStaffDetail(env, tenant(), TARGET);
    expect(detail?.propertyIds).toEqual([PROPERTY_A]);
  });

  it("見つからなければ `undefined`", async () => {
    findOrgStaffDetail.mockResolvedValue(undefined);
    expect(await loadStaffDetail(env, tenant(), TARGET)).toBeUndefined();
  });
});

describe("updateStaff", () => {
  it("保存すると名前・ロール・担当施設が書き換わる", async () => {
    const result = await updateStaff(
      env,
      tenant(),
      ACTOR,
      updateForm({ displayName: "テスト 桜", role: "INSPECTOR", propertyIds: [PROPERTY_B] }),
    );

    expect(result).toEqual({ staffSaved: "UPDATED" });
    expect(updateUserProfile).toHaveBeenCalledWith(env, expect.anything(), {
      userId: TARGET_USER,
      displayName: "テスト 桜",
      email: "hanako@example.com",
      locale: "ja",
    });
    expect(updateMembershipRole).toHaveBeenCalledWith(env, expect.anything(), {
      membershipId: TARGET,
      role: "INSPECTOR",
    });
    expect(replacePropertyAssignments).toHaveBeenCalledWith(env, expect.anything(), {
      membershipId: TARGET,
      propertyIds: [PROPERTY_B],
      assignedBy: ACTOR,
    });
  });

  it("空欄のメールは `null`（消せる）", async () => {
    await updateStaff(env, tenant(), ACTOR, updateForm({ email: "" }));
    expect(updateUserProfile).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({ email: null }),
    );
  });

  it("ロールが変わらないときは `updateMembershipRole()` を呼ばない", async () => {
    await updateStaff(env, tenant(), ACTOR, updateForm());
    expect(updateMembershipRole).not.toHaveBeenCalled();
  });

  it("担当施設が空だと保存できない（本人にタスクが 1 件も出なくなる）", async () => {
    const result = await updateStaff(env, tenant(), ACTOR, updateForm({ propertyIds: [] }));
    expect(result).toEqual({ staffInvalid: true });
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it("スタッフ番号を受け取らない（案内カードと食い違わせない）", async () => {
    const form = updateForm();
    form.set("staffNumber", "S-9999");
    await updateStaff(env, tenant(), ACTOR, form);
    expect(updateUserProfile).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.not.objectContaining({ staffNumber: expect.anything() as unknown }),
    );
  });

  it("管理系ユーザーは編集できない（W-12 の担当）", async () => {
    findOrgStaffDetail.mockResolvedValue(detailRow({ role: "ORG_ADMIN" }));
    const result = await updateStaff(env, tenant(), ACTOR, updateForm({ role: "CLEANER" }));
    expect(result).toEqual({ staffNotField: true });
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it("管理系ロールへは変えられない（Zod が閉じている）", async () => {
    const result = await updateStaff(env, tenant(), ACTOR, updateForm({ role: "ORG_ADMIN" }));
    expect(result).toEqual({ staffInvalid: true });
  });

  it("見つからなければ書き込まない", async () => {
    findOrgStaffDetail.mockResolvedValue(undefined);
    const result = await updateStaff(env, tenant(), ACTOR, updateForm());
    expect(result).toEqual({ staffNotFound: true });
    expect(replacePropertyAssignments).not.toHaveBeenCalled();
  });

  it("担当外の施設のスタッフを引き取れない（今の担当施設も門で見る）", async () => {
    // 施設 B だけを持つ施設責任者が、施設 A のスタッフを B へ移そうとする。
    await expect(
      updateStaff(
        env,
        tenant("PROPERTY_MANAGER", [PROPERTY_B]),
        ACTOR,
        updateForm({ propertyIds: [PROPERTY_B] }),
      ),
    ).rejects.toThrow();
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it("担当外の施設へ送れない（新しい担当施設も門で見る）", async () => {
    // 施設 A だけを持つ施設責任者が、自分のスタッフを B へ送ろうとする。
    await expect(
      updateStaff(
        env,
        tenant("PROPERTY_MANAGER", [PROPERTY_A]),
        ACTOR,
        updateForm({ propertyIds: [PROPERTY_B] }),
      ),
    ).rejects.toThrow();
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it("両方が担当内なら通る", async () => {
    const result = await updateStaff(
      env,
      tenant("PROPERTY_MANAGER", [PROPERTY_A, PROPERTY_B]),
      ACTOR,
      updateForm({ propertyIds: [PROPERTY_B] }),
    );
    expect(result).toEqual({ staffSaved: "UPDATED" });
  });

  it("監査ログを残す（security.md §6）", async () => {
    await updateStaff(env, tenant(), ACTOR, updateForm({ propertyIds: [PROPERTY_B] }));
    expect(recordAudit).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({ actorId: ACTOR, action: "user.updated", targetId: TARGET }),
    );
  });

  it("**監査ログに連絡先を載せない**（`AUDIT_ACTIONS` の注記）", async () => {
    await updateStaff(env, tenant(), ACTOR, updateForm());
    const entry = JSON.stringify(recordAudit.mock.calls[0]?.[2] ?? {});
    for (const forbidden of ["email", "hanako@example.com", "displayName", "テスト 花子"]) {
      expect(entry, forbidden).not.toContain(forbidden);
    }
  });
});

describe("setStaffActive", () => {
  it("停止するとログインの旗が下りる（行は消さない）", async () => {
    const result = await setStaffActive(env, tenant(), ACTOR, {
      membershipId: TARGET,
      isActive: false,
    });
    expect(result).toEqual({ staffSaved: "DEACTIVATED" });
    expect(setUserActive).toHaveBeenCalledWith(env, expect.anything(), {
      userId: TARGET_USER,
      isActive: false,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({ action: "user.deactivated" }),
    );
  });

  it("再開できる（片道の操作にしない）", async () => {
    findOrgStaffDetail.mockResolvedValue(detailRow({ isActive: false }));
    const result = await setStaffActive(env, tenant(), ACTOR, {
      membershipId: TARGET,
      isActive: true,
    });
    expect(result).toEqual({ staffSaved: "REACTIVATED" });
    expect(recordAudit).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({ action: "user.reactivated" }),
    );
  });

  it("自分自身は停められない（うっかり締め出さない）", async () => {
    const result = await setStaffActive(env, tenant(), ACTOR, {
      membershipId: ACTOR,
      isActive: false,
    });
    expect(result).toEqual({ staffSelf: true });
    expect(setUserActive).not.toHaveBeenCalled();
  });

  it("管理系ユーザーは停められない（最後の OWNER を守る安全装置を迂回しない）", async () => {
    findOrgStaffDetail.mockResolvedValue(detailRow({ role: "OWNER" }));
    const result = await setStaffActive(env, tenant(), ACTOR, {
      membershipId: TARGET,
      isActive: false,
    });
    expect(result).toEqual({ staffNotField: true });
    expect(setUserActive).not.toHaveBeenCalled();
  });

  it("担当外の施設のスタッフは停められない", async () => {
    await expect(
      setStaffActive(env, tenant("PROPERTY_MANAGER", [PROPERTY_B]), ACTOR, {
        membershipId: TARGET,
        isActive: false,
      }),
    ).rejects.toThrow();
    expect(setUserActive).not.toHaveBeenCalled();
  });
});
