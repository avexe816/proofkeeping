/**
 * 集計と明細の組み立て（PK-SPEC-P5 §3）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * ── いちばん大事なテスト ────────────────────────────────
 * **料金が決まっていないタスクを黙って落とさない**（§3.2 MUST /
 * billing.md §8）。`unitPrice = 0` の明細として残り、`unpriced` に
 * 理由が入ること。
 */

import { describe, expect, it } from "vitest";

import {
  UNPRICED_UNIT_PRICE,
  aggregateInvoiceLines,
  describeLine,
  type BillableTask,
} from "./aggregate.js";
import type { PricingRuleFact } from "./pricing.js";

const PROPERTY = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const OTHER_PROPERTY = "o7k2m9__prop_01JBXQ3ZK8N4P2VYR6ZZZZZZ";
const SINGLE = "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH";
const TWIN = "o7k2m9__rtyp_01JBXQ3ZK8N4P2VYR6ZZZZZZ";

const ITEM_LABELS: Record<string, string> = {
  CLEAN_CHECKOUT: "アウト清掃",
  CLEAN_STAYOVER: "滞在清掃",
};

function itemLabelOf(code: string): string {
  return ITEM_LABELS[code] ?? code;
}

function task(overrides: Partial<BillableTask> = {}): BillableTask {
  return {
    taskId: "o7k2m9__task_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
    propertyId: PROPERTY,
    propertyName: "サンプルホテル東京",
    roomTypeId: SINGLE,
    roomTypeName: "シングル",
    taskType: "CHECKOUT",
    itemCode: "CLEAN_CHECKOUT",
    serviceDate: "2026-09-09",
    quantity: 1,
    ...overrides,
  };
}

function rule(overrides: Partial<PricingRuleFact> = {}): PricingRuleFact {
  return {
    id: "o7k2m9__prc_01JBXQ3ZK8N4P2VYR6ABCDEFGH",
    propertyId: null,
    roomTypeId: null,
    taskType: null,
    itemCode: "CLEAN_CHECKOUT",
    unitPrice: 3200,
    taxRate: 10,
    isReducedRate: false,
    validFrom: "2026-01-01",
    validTo: null,
    priority: 50,
    ...overrides,
  };
}

/** N 件のタスクを作る（`taskId` を一意にする）。 */
function tasks(count: number, overrides: Partial<BillableTask> = {}): BillableTask[] {
  return Array.from({ length: count }, (_unused, index) =>
    task({ taskId: `task-${String(index)}`, ...overrides }),
  );
}

describe("aggregateInvoiceLines — 明細の粒度（§3.4）", () => {
  it("施設 × 清掃種別 × 客室タイプ でまとめる", () => {
    const result = aggregateInvoiceLines({
      tasks: [...tasks(180), ...tasks(95, { roomTypeId: TWIN, roomTypeName: "ツイン" })],
      pricingRules: [
        rule({ roomTypeId: SINGLE, propertyId: PROPERTY, taskType: "CHECKOUT", unitPrice: 3200 }),
        rule({
          id: "twin",
          roomTypeId: TWIN,
          propertyId: PROPERTY,
          taskType: "CHECKOUT",
          unitPrice: 3800,
        }),
      ],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });

    expect(result.lines).toHaveLength(2);
    const amounts = result.lines.map((row) => row.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([361_000, 576_000]);
  });

  it("施設が違えば別の行", () => {
    const result = aggregateInvoiceLines({
      tasks: [task(), task({ taskId: "t2", propertyId: OTHER_PROPERTY, propertyName: "横浜" })],
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines).toHaveLength(2);
  });

  it("品目が違えば別の行", () => {
    const result = aggregateInvoiceLines({
      tasks: [
        task(),
        task({ taskId: "t2", itemCode: "CLEAN_STAYOVER", taskType: "STAY" }),
      ],
      pricingRules: [rule(), rule({ id: "stay", itemCode: "CLEAN_STAYOVER", unitPrice: 1800 })],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines).toHaveLength(2);
  });

  it("役務提供日は組の中の最初と最後", () => {
    const result = aggregateInvoiceLines({
      tasks: [
        task({ taskId: "a", serviceDate: "2026-09-05" }),
        task({ taskId: "b", serviceDate: "2026-09-20" }),
        task({ taskId: "c", serviceDate: "2026-09-12" }),
      ],
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines[0]).toMatchObject({
      serviceDateFrom: "2026-09-05",
      serviceDateTo: "2026-09-20",
    });
  });

  it("集計元のタスク ID を残す（§6.3 のドリルダウン）", () => {
    const result = aggregateInvoiceLines({
      tasks: [task({ taskId: "b" }), task({ taskId: "a" })],
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    // **並びを固定する**（§4.3 の冪等性）。
    expect(result.lines[0]?.sourceTaskIds).toEqual(["a", "b"]);
  });

  it("**同じ入力からは同じ請求書**（§4.3 の冪等性）", () => {
    const input = {
      tasks: [...tasks(3), ...tasks(2, { roomTypeId: TWIN, roomTypeName: "ツイン" })],
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR" as const,
      itemLabelOf,
    };
    expect(JSON.stringify(aggregateInvoiceLines(input))).toBe(
      JSON.stringify(aggregateInvoiceLines(input)),
    );
  });

  it("行番号が 1 から連番になる", () => {
    const result = aggregateInvoiceLines({
      tasks: [task(), task({ taskId: "t2", roomTypeId: TWIN, roomTypeName: "ツイン" })],
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines.map((row) => row.lineNo)).toEqual([1, 2]);
  });
});

describe("aggregateInvoiceLines — 単価未設定（§3.2 MUST）", () => {
  it("**黙って除外しない。** 0 円の明細として残る", () => {
    const result = aggregateInvoiceLines({
      tasks: tasks(5),
      pricingRules: [],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.unitPrice).toBe(UNPRICED_UNIT_PRICE);
    expect(result.lines[0]?.amount).toBe(0);
  });

  it("警告に件数と組が残る", () => {
    const result = aggregateInvoiceLines({
      tasks: tasks(5),
      pricingRules: [],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.unpriced).toHaveLength(1);
    expect(result.unpriced[0]).toMatchObject({
      propertyId: PROPERTY,
      taskType: "CHECKOUT",
      itemCode: "CLEAN_CHECKOUT",
      taskCount: 5,
    });
  });

  it("行に目印が付く", () => {
    const result = aggregateInvoiceLines({
      tasks: tasks(1),
      pricingRules: [],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines[0]?.isUnpriced).toBe(true);
  });

  it("料金がある組は警告に出ない", () => {
    const result = aggregateInvoiceLines({
      tasks: tasks(3),
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.unpriced).toEqual([]);
    expect(result.lines[0]?.isUnpriced).toBe(false);
  });

  it("一部だけ未設定でも、ある組は正しく計上される", () => {
    const result = aggregateInvoiceLines({
      tasks: [
        ...tasks(2),
        ...tasks(3, { taskId: "s", itemCode: "CLEAN_STAYOVER", taskType: "STAY" }),
      ],
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines).toHaveLength(2);
    expect(result.unpriced).toHaveLength(1);
    expect(result.unpriced[0]?.itemCode).toBe("CLEAN_STAYOVER");
    // 料金のある側は 0 円になっていない。
    const priced = result.lines.find((row) => !row.isUnpriced);
    expect(priced?.amount).toBe(6400);
  });

  it("**0 円の規則があるときは警告を出さない**（無料と決めた）", () => {
    const result = aggregateInvoiceLines({
      tasks: tasks(2),
      pricingRules: [rule({ unitPrice: 0 })],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.unpriced).toEqual([]);
    expect(result.lines[0]?.isUnpriced).toBe(false);
    expect(result.lines[0]?.amount).toBe(0);
  });

  it("タスクが 1 件も無ければ空", () => {
    const result = aggregateInvoiceLines({
      tasks: [],
      pricingRules: [rule()],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.lines).toEqual([]);
    expect(result.unpriced).toEqual([]);
    expect(result.totals.totalAmount).toBe(0);
  });
});

describe("aggregateInvoiceLines — 税額（§3.3）", () => {
  it("税率ごとに 1 回だけ端数処理する", () => {
    const result = aggregateInvoiceLines({
      tasks: tasks(3),
      pricingRules: [rule({ unitPrice: 105 })],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    // 105 × 3 = 315 → 31.5 → 31（行ごとなら 10 × 3 = 30）
    expect(result.totals.taxAmount).toBe(31);
  });

  it("複数の税率が区分される", () => {
    const result = aggregateInvoiceLines({
      tasks: [...tasks(1), ...tasks(1, { taskId: "s", itemCode: "CLEAN_STAYOVER" })],
      pricingRules: [
        rule({ unitPrice: 1000, taxRate: 10 }),
        rule({ id: "stay", itemCode: "CLEAN_STAYOVER", unitPrice: 1000, taxRate: 8 }),
      ],
      taxRoundingMode: "FLOOR",
      itemLabelOf,
    });
    expect(result.totals.summaries).toHaveLength(2);
  });

  it("**金額がすべて整数**（billing.md §4）", () => {
    const result = aggregateInvoiceLines({
      tasks: tasks(7),
      pricingRules: [rule({ unitPrice: 3333 })],
      taxRoundingMode: "ROUND",
      itemLabelOf,
    });
    for (const row of result.lines) expect(Number.isInteger(row.amount)).toBe(true);
    expect(Number.isInteger(result.totals.taxAmount)).toBe(true);
  });
});

describe("describeLine — 明細の説明文（§3.4）", () => {
  it("施設 / 作業 / 客室タイプ", () => {
    expect(
      describeLine({
        propertyName: "サンプルホテル東京",
        itemLabel: "アウト清掃",
        roomTypeName: "シングル",
      }),
    ).toBe("サンプルホテル東京 / アウト清掃 / シングル");
  });

  it("客室タイプが無ければ 2 つ（§3.4 の「滞在清掃」の例）", () => {
    expect(
      describeLine({ propertyName: "サンプルホテル東京", itemLabel: "滞在清掃", roomTypeName: null }),
    ).toBe("サンプルホテル東京 / 滞在清掃");
  });

  it("客室タイプが空文字でも 2 つ", () => {
    expect(
      describeLine({ propertyName: "A", itemLabel: "B", roomTypeName: "" }),
    ).toBe("A / B");
  });
});
