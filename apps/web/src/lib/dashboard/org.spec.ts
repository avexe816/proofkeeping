/**
 * 組織ダッシュボードの畳み込みのテスト（P5-14 / PK-SPEC-P5 §7.1）。
 *
 * ── どこで何を押さえているか ────────────────────────────
 *   ① 月ぶんの足し合わせ …… ここ（純粋関数）
 *   ② 保管期限の判定 …… ここ
 *   ③ 表示の割り算 …… `format.spec.ts`
 *   ④ 組織条件が載ること …… `packages/db/.../repositories.spec.ts`
 *   ⑤ 越境 …… `tests/tenant-isolation/rollup.spec.ts`
 */

import { describe, expect, it } from "vitest";

import {
  foldRollupsByProperty,
  isLostItemExpiring,
  sumTotals,
  type RollupRow,
} from "./org.js";

function row(propertyId: string, overrides: Partial<RollupRow> = {}): RollupRow {
  return {
    propertyId,
    totalTasks: 0,
    completedTasks: 0,
    reworkTasks: 0,
    totalMinutes: 0,
    inspectedTasks: 0,
    firstPassTasks: 0,
    findingsHigh: 0,
    ...overrides,
  };
}

describe("foldRollupsByProperty", () => {
  it("同じ施設の日ごとの行を足す", () => {
    const folded = foldRollupsByProperty([
      row("prop-a", { totalTasks: 40, completedTasks: 39, totalMinutes: 1100 }),
      row("prop-a", { totalTasks: 45, completedTasks: 45, totalMinutes: 1260 }),
    ]);

    expect(folded.get("prop-a")).toMatchObject({
      totalTasks: 85,
      completedTasks: 84,
      totalMinutes: 2360,
    });
  });

  it("施設をまたいで混ぜない", () => {
    const folded = foldRollupsByProperty([
      row("prop-a", { totalTasks: 40 }),
      row("prop-b", { totalTasks: 7 }),
    ]);

    expect(folded.get("prop-a")?.totalTasks).toBe(40);
    expect(folded.get("prop-b")?.totalTasks).toBe(7);
  });

  it("行が無ければ空", () => {
    expect(foldRollupsByProperty([]).size).toBe(0);
  });

  it("検査の 2 列を別々に足す（合格率の分子と分母）", () => {
    const folded = foldRollupsByProperty([
      row("prop-a", { inspectedTasks: 10, firstPassTasks: 9 }),
      row("prop-a", { inspectedTasks: 12, firstPassTasks: 11 }),
    ]);

    expect(folded.get("prop-a")).toMatchObject({ inspectedTasks: 22, firstPassTasks: 20 });
  });

  it("重大な差異は月ぶんを足す", () => {
    const folded = foldRollupsByProperty([
      row("prop-a", { findingsHigh: 2 }),
      row("prop-a", { findingsHigh: 1 }),
      row("prop-a", { findingsHigh: 0 }),
    ]);

    expect(folded.get("prop-a")?.findingsHigh).toBe(3);
  });

  it("**未解決の不具合を足さない。** 現在値なので日数ぶん倍になる", () => {
    // `RollupRow` に `openIssues` が無いこと自体が防御。型で持ち込めない。
    const folded = foldRollupsByProperty([row("prop-a"), row("prop-a")]);
    expect(folded.get("prop-a")).not.toHaveProperty("openIssues");
  });
});

describe("sumTotals", () => {
  it("全施設ぶんを 1 つに畳む", () => {
    const folded = foldRollupsByProperty([
      row("prop-a", { totalTasks: 1412, completedTasks: 1399, findingsHigh: 3 }),
      row("prop-b", { totalTasks: 982, completedTasks: 960, findingsHigh: 7 }),
      row("prop-c", { totalTasks: 453, completedTasks: 439, findingsHigh: 2 }),
    ]);

    expect(sumTotals(folded.values())).toMatchObject({
      totalTasks: 2847,
      completedTasks: 2798,
      findingsHigh: 12,
    });
  });

  it("空なら全部 0", () => {
    expect(sumTotals([])).toMatchObject({ totalTasks: 0, findingsHigh: 0 });
  });
});

describe("isLostItemExpiring — 保管期限（§7.1 の要対応）", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");

  it.each([
    ["2026-09-16T00:00:00.000Z", true],
    ["2026-09-29T00:00:00.000Z", true],
    ["2026-09-01T00:00:00.000Z", true],
  ])("期限 %s は近い（過ぎたものも含む）", (due, expected) => {
    expect(isLostItemExpiring(new Date(due), now)).toBe(expected);
  });

  it.each([["2026-09-30T00:00:00.000Z"], ["2026-12-01T00:00:00.000Z"]])(
    "期限 %s はまだ先",
    (due) => {
      expect(isLostItemExpiring(new Date(due), now)).toBe(false);
    },
  );

  it("期限が未設定なら数えない（判定する材料が無い）", () => {
    expect(isLostItemExpiring(null, now)).toBe(false);
  });

  it("窓の広さを変えられる", () => {
    const due = new Date("2026-10-10T00:00:00.000Z");
    expect(isLostItemExpiring(due, now)).toBe(false);
    expect(isLostItemExpiring(due, now, 30)).toBe(true);
  });
});
