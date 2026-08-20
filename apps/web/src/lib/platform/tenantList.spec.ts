/**
 * テナント一覧の組み立て（PF-04）。
 *
 * 完了条件のうちここが見るもの:
 *   - 一覧が `platform_tenant_snapshot` だけから出ている
 *   - 個人を特定できる列が無い
 *
 * 状態の決め方（停止 > 試用 > 注意 > 稼働中）は
 * `tenantList.ts` の `stateOf()` の注記を読むこと。
 */

import type { PlatformOperationSettings, TenantSnapshotRow } from "@pk/db";
import { describe, expect, it } from "vitest";

import { buildTenantListPage, trialDaysLeft } from "./tenantList.js";

const SETTINGS: PlatformOperationSettings = {
  inputDurationFloorSeconds: 10,
  defaultRateThresholdPercent: 70,
  photoRetentionDays: 90,
  roomsPerStaffLimit: 16,
  maintenanceStartJst: "03:00",
  maintenanceEndJst: "04:00",
};

const BUSINESS_DATE = "2026-08-19";

/** 健全なテナント 1 行（完備率 98% / 既定値 20% / 19 秒）。 */
function snapshot(overrides: Partial<TenantSnapshotRow> = {}): TenantSnapshotRow {
  return {
    organizationId: "abc123__org_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
    businessDate: BUSINESS_DATE,
    name: "サンプル清掃株式会社",
    plan: "PRO",
    subscriptionStatus: "ACTIVE",
    contractedOn: "2025-06-01",
    trialEndsOn: null,
    propertyCount: 8,
    roomCount: 412,
    billableRoomCount: 400,
    staffCount: 31,
    completedTasks: 100,
    observationsRecorded: 98,
    observationsSkipped: 2,
    observationsUsedDefaults: 20,
    inputDurationMedianMs: 19_000,
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("状態の決め方", () => {
  it("稼働中（契約 ACTIVE ＋ 品質が良い）", () => {
    const page = buildTenantListPage([snapshot()], SETTINGS, BUSINESS_DATE);
    expect(page.rows[0]?.state).toBe("ACTIVE");
    expect(page.rows[0]?.needsSupport).toBe(false);
  });

  it("**注意は品質から出る**（契約は ACTIVE のまま）", () => {
    const page = buildTenantListPage(
      [snapshot({ observationsRecorded: 74, inputDurationMedianMs: 8_000 })],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.rows[0]?.state).toBe("ATTENTION");
    expect(page.rows[0]?.completenessPercent).toBe(74);
  });

  it("**試用中は品質が悪くても「注意」で塗らない**（定着途中を赤くしない）", () => {
    const page = buildTenantListPage(
      [
        snapshot({
          subscriptionStatus: "TRIAL",
          observationsRecorded: 74,
          inputDurationMedianMs: 8_000,
        }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.rows[0]?.state).toBe("TRIAL");
    // 判定そのものは出ている（カードで使える）。
    expect(page.rows[0]?.needsSupport).toBe(true);
  });

  it("**停止が最優先**（契約が切れていれば品質の話にしない）", () => {
    for (const status of ["CANCELED", "PAST_DUE"]) {
      const page = buildTenantListPage(
        [snapshot({ subscriptionStatus: status })],
        SETTINGS,
        BUSINESS_DATE,
      );
      expect(page.rows[0]?.state).toBe("SUSPENDED");
    }
  });

  it("契約が無ければ稼働中として扱う（品質だけで見る）", () => {
    const page = buildTenantListPage(
      [snapshot({ subscriptionStatus: null, plan: null })],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.rows[0]?.state).toBe("ACTIVE");
  });
});

describe("KPI と集計", () => {
  it("5 つの数を数える", () => {
    const page = buildTenantListPage(
      [
        snapshot({ organizationId: "a__org_1" }),
        snapshot({ organizationId: "b__org_2", subscriptionStatus: "TRIAL" }),
        snapshot({ organizationId: "c__org_3", observationsRecorded: 70, inputDurationMedianMs: 5_000 }),
        snapshot({ organizationId: "d__org_4", subscriptionStatus: "CANCELED" }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.summary).toEqual({
      tenants: 4,
      // a=稼働中 / b=試用中 / c=要確認 / d=停止。**稼働中は 1 社。**
      active: 1,
      trial: 1,
      attention: 1,
      properties: 32,
      rooms: 1648,
    });
  });

  it("プラン別に社数と施設数をまとめる", () => {
    const page = buildTenantListPage(
      [
        snapshot({ organizationId: "a__org_1", plan: "PRO" }),
        snapshot({ organizationId: "b__org_2", plan: "PRO" }),
        snapshot({ organizationId: "c__org_3", plan: "BASE", propertyCount: 3 }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    const pro = page.plans.find((plan) => plan.plan === "PRO");
    expect(pro).toEqual({ plan: "PRO", tenants: 2, properties: 16 });
    expect(page.plans.find((plan) => plan.plan === "BASE")).toEqual({
      plan: "BASE",
      tenants: 1,
      properties: 3,
    });
  });

  it("**契約の無いテナントをプラン別に並べない**（行が作れない）", () => {
    const page = buildTenantListPage([snapshot({ plan: null })], SETTINGS, BUSINESS_DATE);
    expect(page.plans).toEqual([]);
    // 一覧には出る（テナントは実在する）。
    expect(page.rows).toHaveLength(1);
  });

  it("完備率が出せない日は `null`（0% にしない）", () => {
    const page = buildTenantListPage(
      [snapshot({ completedTasks: 0, observationsRecorded: 0 })],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.rows[0]?.completenessPercent).toBeNull();
    expect(page.rows[0]?.state).toBe("ACTIVE");
  });

  it("スナップショットが 0 件でも壊れない", () => {
    const page = buildTenantListPage([], SETTINGS, null);
    expect(page.summary.tenants).toBe(0);
    expect(page.rows).toEqual([]);
    expect(page.businessDate).toBeNull();
  });
});

describe("閾値は運用設定から来る（ベタ書きしない / DECISIONS #233）", () => {
  it("既定値のまま比率の閾値を上げると「注意」が消える", () => {
    const rows = [snapshot({ observationsRecorded: 80, observationsUsedDefaults: 73 })];
    expect(buildTenantListPage(rows, SETTINGS, BUSINESS_DATE).rows[0]?.state).toBe("ATTENTION");
    expect(
      buildTenantListPage(rows, { ...SETTINGS, defaultRateThresholdPercent: 95 }, BUSINESS_DATE)
        .rows[0]?.state,
    ).toBe("ACTIVE");
  });
});

describe("個人を特定できる値を持たない（INV-10 / 完了条件）", () => {
  it("行の鍵に氏名・メール・端末が無い", () => {
    const page = buildTenantListPage([snapshot()], SETTINGS, BUSINESS_DATE);
    const keys = Object.keys(page.rows[0] ?? {});
    for (const forbidden of ["displayName", "email", "staffNumber", "deviceId", "recordedById"]) {
      expect(keys).not.toContain(forbidden);
    }
    // スタッフは**人数だけ。**
    expect(keys).toContain("staffCount");
  });
});

describe("trialDaysLeft", () => {
  it("業務日どうしの引き算（`Date.now()` を使わない）", () => {
    expect(trialDaysLeft("2026-09-06", "2026-08-19")).toBe(18);
  });

  it("過ぎていれば負の数", () => {
    expect(trialDaysLeft("2026-08-10", "2026-08-19")).toBe(-9);
  });

  it("期限が無ければ `null`", () => {
    expect(trialDaysLeft(null, "2026-08-19")).toBeNull();
    expect(trialDaysLeft("2026-09-06", null)).toBeNull();
  });

  it("形が違えば `null`", () => {
    expect(trialDaysLeft("いつか", "2026-08-19")).toBeNull();
  });
});
