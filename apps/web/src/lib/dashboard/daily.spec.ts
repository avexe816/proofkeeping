/**
 * ダッシュボード（本日の運用）の組み立ての検査。
 *
 * 参照: ui-prototypes/ops/pkops-A-daily-quality.html（01）
 * ルール: testing.md §3（純粋関数は正例と負例）
 */

import type { PropertySummary } from "@pk/contracts";
import { describe, expect, it } from "vitest";

import { buildDailyDashboard, buildDailyQuality, recentBusinessDates } from "./daily.js";

const DATE = "2026-08-11";

function summary(overrides: Partial<PropertySummary> & { propertyId: string }): PropertySummary {
  return {
    propertyId: overrides.propertyId,
    code: overrides.code ?? overrides.propertyId,
    name: overrides.name ?? overrides.propertyId,
    roomCount: overrides.roomCount ?? 10,
    hasRollup: overrides.hasRollup ?? true,
    totalTasks: overrides.totalTasks ?? 0,
    completedTasks: overrides.completedTasks ?? 0,
    reworkTasks: overrides.reworkTasks ?? 0,
    openIssues: overrides.openIssues ?? 0,
  };
}

const NO_TREND = {
  completedByDate: new Map<string, number>(),
  dates: [] as string[],
  currentDate: DATE,
};

describe("buildDailyDashboard — 施設別の並び", () => {
  it("要確認の多い順に並べる（進捗率順ではない）", () => {
    const view = buildDailyDashboard(
      [
        summary({ propertyId: "a", name: "A", totalTasks: 10, completedTasks: 9, openIssues: 0 }),
        summary({ propertyId: "b", name: "B", totalTasks: 10, completedTasks: 2, openIssues: 3 }),
        summary({ propertyId: "c", name: "C", totalTasks: 10, completedTasks: 8, openIssues: 1 }),
      ],
      null,
      new Map([["c", 4]]),
      NO_TREND,
    );

    // C は差異 4 ＋ 不具合 1 = 5 で最多。進捗率は A が最良だが最後。
    expect(view.rows.map((row) => row.propertyId)).toEqual(["c", "b", "a"]);
  });

  it("要確認が同数なら未完了の多い順", () => {
    const view = buildDailyDashboard(
      [
        summary({ propertyId: "a", name: "A", totalTasks: 10, completedTasks: 9, openIssues: 2 }),
        summary({ propertyId: "b", name: "B", totalTasks: 10, completedTasks: 1, openIssues: 2 }),
      ],
      null,
      new Map(),
      NO_TREND,
    );

    expect(view.rows.map((row) => row.propertyId)).toEqual(["b", "a"]);
  });

  it("要確認も未完了も同数なら名前順（並びが毎回変わらない）", () => {
    const view = buildDailyDashboard(
      [
        summary({ propertyId: "b", name: "B", totalTasks: 4, completedTasks: 2 }),
        summary({ propertyId: "a", name: "A", totalTasks: 4, completedTasks: 2 }),
      ],
      null,
      new Map(),
      NO_TREND,
    );

    expect(view.rows.map((row) => row.name)).toEqual(["A", "B"]);
  });
});

describe("buildDailyDashboard — 集計がまだ無い施設", () => {
  it("進捗率を出さず、合計からも除く", () => {
    const view = buildDailyDashboard(
      [
        summary({ propertyId: "a", totalTasks: 10, completedTasks: 5 }),
        summary({ propertyId: "b", hasRollup: false, totalTasks: 0, completedTasks: 0 }),
      ],
      null,
      new Map(),
      NO_TREND,
    );

    const pending = view.rows.find((row) => row.propertyId === "b");
    expect(pending?.percent).toBeNull();
    expect(pending?.percentValue).toBeNull();
    // 合計は集計のある施設だけ。50.0% のまま下がらない。
    expect(view.totals.totalTasks).toBe(10);
    expect(view.totals.completedTasks).toBe(5);
    expect(view.totals.percent).toBe("50.0%");
    expect(view.totals.pendingProperties).toBe(1);
  });

  it("施設数と客室数は集計の有無に関わらず数える", () => {
    const view = buildDailyDashboard(
      [
        summary({ propertyId: "a", roomCount: 60 }),
        summary({ propertyId: "b", roomCount: 24, hasRollup: false }),
      ],
      null,
      new Map(),
      NO_TREND,
    );

    expect(view.totals.propertyCount).toBe(2);
    expect(view.totals.roomCount).toBe(84);
  });
});

describe("buildDailyDashboard — 施設の絞り込み", () => {
  it("scope の施設だけを残す", () => {
    const view = buildDailyDashboard(
      [summary({ propertyId: "a" }), summary({ propertyId: "b" })],
      ["b"],
      new Map(),
      NO_TREND,
    );

    expect(view.rows.map((row) => row.propertyId)).toEqual(["b"]);
    expect(view.totals.propertyCount).toBe(1);
  });

  it("`null` なら全施設", () => {
    const view = buildDailyDashboard(
      [summary({ propertyId: "a" }), summary({ propertyId: "b" })],
      null,
      new Map(),
      NO_TREND,
    );

    expect(view.rows).toHaveLength(2);
  });
});

describe("buildDailyDashboard — 直近 7 日", () => {
  const dates = recentBusinessDates(DATE, 7);

  it("最大の日を 100% として棒の高さを出す", () => {
    const view = buildDailyDashboard([summary({ propertyId: "a" })], null, new Map(), {
      completedByDate: new Map([
        [dates[0] as string, 200],
        [dates[6] as string, 100],
      ]),
      dates,
      currentDate: DATE,
    });

    expect(view.trend[0]?.heightPercent).toBe(100);
    expect(view.trend[6]?.heightPercent).toBe(50);
    expect(view.trend[6]?.isCurrent).toBe(true);
  });

  it("記録の無い日は 0 件として並べる（日を飛ばさない）", () => {
    const view = buildDailyDashboard([summary({ propertyId: "a" })], null, new Map(), {
      completedByDate: new Map([[dates[6] as string, 10]]),
      dates,
      currentDate: DATE,
    });

    expect(view.trend).toHaveLength(7);
    expect(view.trend[0]?.completedTasks).toBe(0);
  });

  it("全日 0 でも高さの計算で落ちない", () => {
    const view = buildDailyDashboard([summary({ propertyId: "a" })], null, new Map(), {
      completedByDate: new Map(),
      dates,
      currentDate: DATE,
    });

    expect(view.trend.every((point) => point.heightPercent === 0)).toBe(true);
    expect(view.trendAverage).toBe(0);
  });
});

describe("recentBusinessDates", () => {
  it("古い順に 7 日ぶんを並べ、末尾が基準日", () => {
    const dates = recentBusinessDates("2026-08-11", 7);
    expect(dates).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
    ]);
  });

  it("月をまたいでも正しく戻る", () => {
    expect(recentBusinessDates("2026-03-02", 3)).toEqual([
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });
});

describe("buildDailyQuality — 記録の品質", () => {
  it("完備率は観察件数 / 対象タスク", () => {
    const quality = buildDailyQuality(
      [
        { usedDefaults: false, inputDurationMs: 15_000 },
        { usedDefaults: true, inputDurationMs: 17_000 },
      ],
      4,
    );

    expect(quality.inputPercent).toBe("50.0%");
    expect(quality.observationCount).toBe(2);
    expect(quality.taskCount).toBe(4);
  });

  it("既定値のまま確定した比率は観察が分母", () => {
    const quality = buildDailyQuality(
      [
        { usedDefaults: true, inputDurationMs: null },
        { usedDefaults: true, inputDurationMs: null },
        { usedDefaults: false, inputDurationMs: null },
        { usedDefaults: false, inputDurationMs: null },
      ],
      100,
    );

    expect(quality.defaultPercent).toBe("50.0%");
  });

  it("中央値は奇数個なら真ん中", () => {
    const quality = buildDailyQuality(
      [
        { usedDefaults: false, inputDurationMs: 12_000 },
        { usedDefaults: false, inputDurationMs: 17_000 },
        { usedDefaults: false, inputDurationMs: 90_000 },
      ],
      3,
    );

    // 極端な 90 秒に引っぱられない（平均なら 39.7 秒）。
    expect(quality.durationMedianSeconds).toBe(17);
  });

  it("中央値は偶数個なら中央 2 つの平均", () => {
    const quality = buildDailyQuality(
      [
        { usedDefaults: false, inputDurationMs: 10_000 },
        { usedDefaults: false, inputDurationMs: 20_000 },
      ],
      2,
    );

    expect(quality.durationMedianSeconds).toBe(15);
  });

  it("未計測は中央値の母数に入れない", () => {
    const quality = buildDailyQuality(
      [
        { usedDefaults: false, inputDurationMs: null },
        { usedDefaults: false, inputDurationMs: 20_000 },
      ],
      2,
    );

    expect(quality.durationMedianSeconds).toBe(20);
  });

  it("観察が 1 件も無ければ 0% ではなく null（母数が無いのと 0 は違う）", () => {
    const quality = buildDailyQuality([], 0);

    expect(quality.inputPercent).toBeNull();
    expect(quality.defaultPercent).toBeNull();
    expect(quality.durationMedianSeconds).toBeNull();
  });
});
