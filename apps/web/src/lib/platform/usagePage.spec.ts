/**
 * 利用状況の組み立て（PF-05）。
 *
 * 完了条件:
 *   - 品質の表が**下位から**並ぶ（良い順にしない）
 *   - 判定の 3 指標が PF-14 の設定値を読んでいる（ベタ書きしない）
 *   - 個人単位の列も絞り込みも無い
 */

import type { PlatformOperationSettings, TenantSnapshotRow } from "@pk/db";
import { COMPLETENESS_THRESHOLD_PERCENT } from "@pk/engine";
import { describe, expect, it } from "vitest";

import { ja } from "../../locales/index.js";

import { buildUsagePage, buildVerdictNote } from "./usagePage.js";

const SETTINGS: PlatformOperationSettings = {
  inputDurationFloorSeconds: 10,
  defaultRateThresholdPercent: 70,
  photoRetentionDays: 90,
  roomsPerStaffLimit: 16,
  maintenanceStartJst: "03:00",
  maintenanceEndJst: "04:00",
};

const BUSINESS_DATE = "2026-08-19";

function snapshot(overrides: Partial<TenantSnapshotRow> = {}): TenantSnapshotRow {
  return {
    organizationId: "abc123__org_1",
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
    findingsHigh: 3,
    photoCount: 240,
    localeCounts: { ja: 4, vi: 20, my: 7 },
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("品質の表は下位から並ぶ（完了条件）", () => {
  it("**要支援を先頭に置く**（良い順にしない）", () => {
    const page = buildUsagePage(
      [
        snapshot({ organizationId: "good__org", name: "良い会社" }),
        snapshot({
          organizationId: "bad__org",
          name: "手当てが要る会社",
          observationsRecorded: 74,
          inputDurationMedianMs: 8_000,
        }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.quality.map((row) => row.name)).toEqual(["手当てが要る会社", "良い会社"]);
    expect(page.quality[0]?.needsSupport).toBe(true);
  });

  it("該当数が多いほど先（3 指標 > 2 指標）", () => {
    const page = buildUsagePage(
      [
        snapshot({
          organizationId: "two__org",
          name: "2 指標",
          observationsRecorded: 74,
          inputDurationMedianMs: 8_000,
        }),
        snapshot({
          organizationId: "three__org",
          name: "3 指標",
          observationsRecorded: 50,
          observationsUsedDefaults: 45,
          inputDurationMedianMs: 2_000,
        }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.quality.map((row) => row.name)).toEqual(["3 指標", "2 指標"]);
  });

  it("同じ該当数なら完備率の低い順", () => {
    const page = buildUsagePage(
      [
        snapshot({ organizationId: "a__org", name: "完備率 96", observationsRecorded: 96 }),
        snapshot({ organizationId: "b__org", name: "完備率 92", observationsRecorded: 92 }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.quality.map((row) => row.name)).toEqual(["完備率 92", "完備率 96"]);
  });

  it("**完備率が出せないテナントを先頭に置かない**（記録が無い ≠ 悪い）", () => {
    const page = buildUsagePage(
      [
        snapshot({ organizationId: "none__org", name: "記録なし", completedTasks: 0, observationsRecorded: 0 }),
        snapshot({ organizationId: "low__org", name: "完備率 92", observationsRecorded: 92 }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.quality[0]?.name).toBe("完備率 92");
    expect(page.quality[1]?.completenessPercent).toBeNull();
  });
});

describe("判定は PF-14 の設定値を読む（完了条件 / ベタ書きしない）", () => {
  it("既定値のまま比率の閾値を上げると「要支援」が消える", () => {
    const rows = [snapshot({ observationsRecorded: 80, observationsUsedDefaults: 73 })];
    expect(buildUsagePage(rows, SETTINGS, BUSINESS_DATE).quality[0]?.needsSupport).toBe(true);
    expect(
      buildUsagePage(rows, { ...SETTINGS, defaultRateThresholdPercent: 95 }, BUSINESS_DATE)
        .quality[0]?.needsSupport,
    ).toBe(false);
  });

  it("入力時間の基準を上げると該当が増える", () => {
    const rows = [snapshot({ observationsRecorded: 74 })];
    expect(buildUsagePage(rows, SETTINGS, BUSINESS_DATE).quality[0]?.signalCount).toBe(1);
    expect(
      buildUsagePage(rows, { ...SETTINGS, inputDurationFloorSeconds: 30 }, BUSINESS_DATE)
        .quality[0]?.signalCount,
    ).toBe(2);
  });
});

describe("KPI", () => {
  it("合計を数える", () => {
    const page = buildUsagePage(
      [
        snapshot({ organizationId: "a__org" }),
        snapshot({ organizationId: "b__org", completedTasks: 50, observationsRecorded: 40, photoCount: 60, findingsHigh: 1 }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.summary.completedTasks).toBe(150);
    expect(page.summary.photoCount).toBe(300);
    expect(page.summary.findings).toBe(4);
    // 138 / 150 = 92%
    expect(page.summary.completenessPercent).toBe(92);
  });

  it("完了タスクが 0 なら完備率は `null`（0% にしない）", () => {
    const page = buildUsagePage(
      [snapshot({ completedTasks: 0, observationsRecorded: 0 })],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.summary.completenessPercent).toBeNull();
  });

  it("**出す元の無い KPI を持たない**（アクティブ端末・通信量）", () => {
    const page = buildUsagePage([snapshot()], SETTINGS, BUSINESS_DATE);
    const keys = Object.keys(page.summary);
    for (const forbidden of ["activeDevices", "storageBytes", "trafficBytes", "p95", "errorRate"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("言語の利用割合（軸は言語だけ / security.md §5）", () => {
  it("テナントをまたいで足し、多い順に並べる", () => {
    const page = buildUsagePage(
      [
        snapshot({ organizationId: "a__org", localeCounts: { ja: 4, vi: 20 } }),
        snapshot({ organizationId: "b__org", localeCounts: { ja: 2, my: 10 } }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.locales.map((row) => [row.locale, row.people])).toEqual([
      ["vi", 20],
      ["my", 10],
      ["ja", 6],
    ]);
    expect(page.totalPeople).toBe(36);
    // 6 / 36 = 16%
    expect(page.locales.find((row) => row.locale === "ja")?.percent).toBe(16);
  });

  it("人数が 0 なら割合は `null`（0% にしない）", () => {
    const page = buildUsagePage([snapshot({ localeCounts: {} })], SETTINGS, BUSINESS_DATE);
    expect(page.locales).toEqual([]);
    expect(page.totalPeople).toBe(0);
  });

  it("**個人を特定できる値を持たない**（言語 → 人数だけ）", () => {
    const page = buildUsagePage([snapshot()], SETTINGS, BUSINESS_DATE);
    const keys = Object.keys(page.locales[0] ?? {});
    expect(keys.sort()).toEqual(["locale", "people", "percent"]);
    for (const row of page.quality) {
      const rowKeys = Object.keys(row);
      for (const forbidden of ["displayName", "email", "staffNumber", "recordedById", "userId"]) {
        expect(rowKeys).not.toContain(forbidden);
      }
    }
  });
});

describe("スナップショットが 0 件でも壊れない", () => {
  it("空の日", () => {
    const page = buildUsagePage([], SETTINGS, null);
    expect(page.quality).toEqual([]);
    expect(page.locales).toEqual([]);
    expect(page.summary.completenessPercent).toBeNull();
    expect(page.businessDate).toBeNull();
  });
});

describe("未計測（`null`）を 0 に落とさない（オーナー指摘 / DECISIONS #242）", () => {
  it("写真と差異が未計測なら合計も `null`", () => {
    const page = buildUsagePage(
      [snapshot({ photoCount: null, findingsHigh: null })],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.summary.photoCount).toBeNull();
    expect(page.summary.findings).toBeNull();
  });

  it("**1 つでも未計測が混ざったら合計は `null`**（測れたぶんだけ足さない）", () => {
    const page = buildUsagePage(
      [
        snapshot({ organizationId: "a__org", photoCount: 100, findingsHigh: 2 }),
        snapshot({ organizationId: "b__org", photoCount: null, findingsHigh: null }),
      ],
      SETTINGS,
      BUSINESS_DATE,
    );
    // 100 を「実測」として出すと、b のぶんを 0 と数えた合計になる。
    expect(page.summary.photoCount).toBeNull();
    expect(page.summary.findings).toBeNull();
  });

  it("言語が未計測なら表を出さず `totalPeople` も `null`", () => {
    const page = buildUsagePage([snapshot({ localeCounts: null })], SETTINGS, BUSINESS_DATE);
    expect(page.locales).toEqual([]);
    expect(page.totalPeople).toBeNull();
  });

  it("**`{}`（数えたが 0 人）と `null`（未計測）を分ける**", () => {
    const measured = buildUsagePage([snapshot({ localeCounts: {} })], SETTINGS, BUSINESS_DATE);
    expect(measured.totalPeople).toBe(0);

    const unmeasured = buildUsagePage([snapshot({ localeCounts: null })], SETTINGS, BUSINESS_DATE);
    expect(unmeasured.totalPeople).toBeNull();
  });

  it("未計測でも品質の表は出る（3 列は判定に使っていない）", () => {
    const page = buildUsagePage(
      [snapshot({ photoCount: null, findingsHigh: null, localeCounts: null })],
      SETTINGS,
      BUSINESS_DATE,
    );
    expect(page.quality).toHaveLength(1);
    expect(page.quality[0]?.completenessPercent).not.toBeNull();
  });
});

describe("判定の説明文は設定値から作る（オーナー指摘 / DECISIONS #242）", () => {
  /** `ja.json` のテンプレート。**数値を持たない。** */
  const TEMPLATE = ja["plat.usage.note.verdict"];

  it("`ja.json` に数値が固定されていない", () => {
    expect(TEMPLATE).toContain("{completeness}");
    expect(TEMPLATE).toContain("{defaultRate}");
    expect(TEMPLATE).toContain("{seconds}");
    // 既定値がそのまま文言に埋まっていないこと。
    expect(TEMPLATE).not.toContain("90%");
    expect(TEMPLATE).not.toContain("70%");
    expect(TEMPLATE).not.toContain("10秒");
  });

  it("既定値ならプロトタイプの逐語と一致する", () => {
    const page = buildUsagePage([snapshot()], SETTINGS, BUSINESS_DATE);
    expect(buildVerdictNote(TEMPLATE, page.thresholds)).toBe(
      "判定は3指標の組み合わせです。完備率90%未満・既定値70%超・入力時間10秒未満のうち2つ以上該当で「要支援」とします。",
    );
  });

  it("**設定を変えると説明文も変わる**（表示と判定が食い違わない）", () => {
    const changed = buildUsagePage(
      [snapshot()],
      { ...SETTINGS, defaultRateThresholdPercent: 85, inputDurationFloorSeconds: 5 },
      BUSINESS_DATE,
    );
    const note = buildVerdictNote(TEMPLATE, changed.thresholds);
    expect(note).toContain("既定値85%超");
    expect(note).toContain("入力時間5秒未満");
    expect(note).not.toContain("70%");
    expect(note).not.toContain("10秒");
  });

  it("説明文の閾値と、実際の判定に使う閾値が同じ", () => {
    const settings = { ...SETTINGS, defaultRateThresholdPercent: 85, inputDurationFloorSeconds: 5 };
    const page = buildUsagePage([snapshot()], settings, BUSINESS_DATE);
    expect(page.thresholds.defaultRatePercent).toBe(settings.defaultRateThresholdPercent);
    expect(page.thresholds.inputDurationFloorSeconds).toBe(settings.inputDurationFloorSeconds);
    // 完備率だけは PF-14 の 5 項目に無いのでコード上の定数（engine）。
    expect(page.thresholds.completenessPercent).toBe(COMPLETENESS_THRESHOLD_PERCENT);
  });
});
