import type { PropertySummary } from "@pk/contracts";
import { describe, expect, it } from "vitest";

import type { ListScope } from "../property/listScope.js";

import { buildProgressView } from "./progress.js";

/**
 * P7-19 進捗モニタの組み立て。
 *
 * 権限（誰がどの施設まで見えるか）は `listScope.spec.ts` が持つ。
 * ここは**絞り込みと合計の算術**だけを見る。
 */

function summary(overrides: Partial<PropertySummary> & { propertyId: string }): PropertySummary {
  return {
    code: "HTL",
    name: "施設",
    roomCount: 10,
    hasRollup: true,
    totalTasks: 0,
    completedTasks: 0,
    reworkTasks: 0,
    openIssues: 0,
    ...overrides,
  };
}

const ORG_SCOPE: ListScope = { propertyIds: null, selectedPropertyId: null, canSelectAll: true };

describe("buildProgressView", () => {
  it("scope が組織全体なら全施設を返す", () => {
    const view = buildProgressView(
      [summary({ propertyId: "p1" }), summary({ propertyId: "p2" })],
      ORG_SCOPE,
    );

    expect(view.rows.map((row) => row.propertyId)).toEqual(["p1", "p2"]);
  });

  it("scope の施設集合で絞る（担当外・選択外は行に出ない）", () => {
    const view = buildProgressView(
      [summary({ propertyId: "p1" }), summary({ propertyId: "p2" }), summary({ propertyId: "p3" })],
      { propertyIds: ["p2"], selectedPropertyId: "p2", canSelectAll: false },
    );

    expect(view.rows.map((row) => row.propertyId)).toEqual(["p2"]);
  });

  it("進捗率は完了 / 予定。合計も同じ式で出す", () => {
    const view = buildProgressView(
      [
        summary({ propertyId: "p1", totalTasks: 60, completedTasks: 45 }),
        summary({ propertyId: "p2", totalTasks: 40, completedTasks: 30 }),
      ],
      ORG_SCOPE,
    );

    expect(view.rows[0]?.percent).toBe("75.0%");
    expect(view.totals).toMatchObject({
      totalTasks: 100,
      completedTasks: 75,
      reworkTasks: 0,
      percent: "75.0%",
      pendingProperties: 0,
    });
  });

  it("rollup が無い施設は進捗率 null で、合計に混ぜない", () => {
    // **混ぜると集計前の施設が増えるほど全体が下がって見える。**
    const view = buildProgressView(
      [
        summary({ propertyId: "p1", totalTasks: 50, completedTasks: 50 }),
        summary({ propertyId: "p2", hasRollup: false }),
      ],
      ORG_SCOPE,
    );

    expect(view.rows[1]?.percent).toBeNull();
    expect(view.totals.percent).toBe("100.0%");
    expect(view.totals.totalTasks).toBe(50);
    expect(view.totals.pendingProperties).toBe(1);
  });

  it("予定 0 件は 0% ではなく null（formatPercent の分母 0）", () => {
    const view = buildProgressView([summary({ propertyId: "p1" })], ORG_SCOPE);

    expect(view.rows[0]?.percent).toBeNull();
    expect(view.totals.percent).toBeNull();
  });

  it("再清掃の合計は rollup がある施設だけを足す", () => {
    const view = buildProgressView(
      [
        summary({ propertyId: "p1", totalTasks: 10, reworkTasks: 2 }),
        summary({ propertyId: "p2", hasRollup: false, reworkTasks: 9 }),
      ],
      ORG_SCOPE,
    );

    expect(view.totals.reworkTasks).toBe(2);
  });

  it("リネンは記録が無ければ null（0 と区別する）", () => {
    const view = buildProgressView(
      [summary({ propertyId: "p1" }), summary({ propertyId: "p2" })],
      ORG_SCOPE,
      new Map([["p1", { collectedQty: 12, suppliedQty: 10 }]]),
    );

    expect(view.rows[0]?.linen).toEqual({ collectedQty: 12, suppliedQty: 10 });
    expect(view.rows[1]?.linen).toBeNull();
    expect(view.totals.linen).toEqual({ collectedQty: 12, suppliedQty: 10 });
  });

  it("リネンの合計は scope で絞った行だけを足す", () => {
    const view = buildProgressView(
      [summary({ propertyId: "p1" }), summary({ propertyId: "p2" })],
      { propertyIds: ["p1"], selectedPropertyId: "p1", canSelectAll: false },
      new Map([
        ["p1", { collectedQty: 3, suppliedQty: 4 }],
        ["p2", { collectedQty: 100, suppliedQty: 100 }],
      ]),
    );

    expect(view.totals.linen).toEqual({ collectedQty: 3, suppliedQty: 4 });
  });

  it("行にも合計にも人の識別子が無い（CLAUDE.md §4）", () => {
    const view = buildProgressView([summary({ propertyId: "p1" })], ORG_SCOPE);

    const keys = [...Object.keys(view.rows[0] ?? {}), ...Object.keys(view.totals)];
    for (const key of keys) {
      expect(key).not.toMatch(/user|staff|member|cleaner/i);
    }
  });
});
