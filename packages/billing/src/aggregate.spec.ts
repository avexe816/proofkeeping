/**
 * 集計と請求書ドラフトの検査（PK-SPEC-P5 §3）。
 *
 * task:  docs/tasks/P5-04.md
 * ルール: .claude/rules/testing.md §3・§4
 */

import { describe, expect, it } from "vitest";

import { buildInvoiceDraft, type BillableTask } from "./aggregate.js";
import type { PricingRuleCandidate } from "./pricing.js";

function task(overrides: Partial<BillableTask> = {}): BillableTask {
  return {
    taskId: "task_1",
    propertyId: "prop_tokyo",
    propertyName: "サンプルホテル東京",
    roomTypeId: "rt_single",
    roomTypeName: "シングル",
    taskType: "CHECKOUT",
    businessDate: "2026-09-10",
    status: "COMPLETED",
    isRework: false,
    ...overrides,
  };
}

function tasks(count: number, overrides: Partial<BillableTask> = {}): BillableTask[] {
  return Array.from({ length: count }, (_v, i) =>
    task({ taskId: `task_${String(i).padStart(4, "0")}`, ...overrides }),
  );
}

function rule(overrides: Partial<PricingRuleCandidate>): PricingRuleCandidate {
  return {
    id: "rule_1",
    propertyId: null,
    roomTypeId: null,
    taskType: null,
    itemCode: "CLEAN_CHECKOUT",
    unitPrice: 3_200,
    taxRate: 10,
    isReducedRate: false,
    validFrom: "2026-01-01",
    validTo: null,
    priority: 50,
    ...overrides,
  };
}

describe("buildInvoiceDraft — §3.4 の粒度でまとめる", () => {
  const pricingRules = [
    rule({
      id: "single",
      propertyId: "prop_tokyo",
      roomTypeId: "rt_single",
      taskType: "CHECKOUT",
      unitPrice: 3_200,
    }),
    rule({
      id: "twin",
      propertyId: "prop_tokyo",
      roomTypeId: "rt_twin",
      taskType: "CHECKOUT",
      unitPrice: 3_800,
    }),
    rule({
      id: "stay",
      propertyId: "prop_tokyo",
      taskType: "STAYOVER",
      itemCode: "CLEAN_STAYOVER",
      unitPrice: 1_800,
    }),
  ];

  const input = {
    tasks: [
      ...tasks(180),
      ...tasks(95, { roomTypeId: "rt_twin", roomTypeName: "ツイン" }).map((t) => ({
        ...t,
        taskId: `twin_${t.taskId}`,
      })),
      ...tasks(42, { taskType: "STAYOVER" as const }).map((t) => ({
        ...t,
        taskId: `stay_${t.taskId}`,
      })),
    ],
    pricingRules,
    taxRoundingMode: "FLOOR" as const,
  };

  it("施設 × 清掃種別 × 客室タイプ で 3 行になる", () => {
    const draft = buildInvoiceDraft(input);
    expect(draft.lines).toHaveLength(3);
    expect(draft.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
  });

  it("§3.4 の例と同じ金額になる", () => {
    const draft = buildInvoiceDraft(input);
    const amounts = new Map(draft.lines.map((l) => [l.description, l.amount]));
    expect(amounts.get("サンプルホテル東京 / アウト清掃 / シングル")).toBe(576_000);
    expect(amounts.get("サンプルホテル東京 / アウト清掃 / ツイン")).toBe(361_000);
    expect(amounts.get("サンプルホテル東京 / 滞在清掃 / シングル")).toBe(75_600);
  });

  it("合計は 税抜 1,012,600 / 税込 1,113,860（§4.1 の画面例）", () => {
    const draft = buildInvoiceDraft(input);
    expect(draft.subtotalAmount).toBe(1_012_600);
    expect(draft.taxAmount).toBe(101_260);
    expect(draft.totalAmount).toBe(1_113_860);
  });

  it("警告は出ない", () => {
    expect(buildInvoiceDraft(input).warnings).toEqual([]);
  });

  it("入力の並び順を変えても結果が変わらない（冪等 / testing.md §4）", () => {
    const forward = buildInvoiceDraft(input);
    const backward = buildInvoiceDraft({ ...input, tasks: [...input.tasks].reverse() });
    expect(backward).toEqual(forward);
  });

  it("3 回実行しても結果が変わらない", () => {
    const results = [1, 2, 3].map(() => buildInvoiceDraft(input));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});

describe("buildInvoiceDraft — 単価未設定は ¥0 明細＋警告（§3.2 MUST）", () => {
  const input = {
    tasks: tasks(12),
    pricingRules: [],
    taxRoundingMode: "FLOOR" as const,
  };

  it("黙って落とさない。明細に残る", () => {
    const draft = buildInvoiceDraft(input);
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]?.quantity).toBe(12);
  });

  it("単価と金額は 0", () => {
    const [line] = buildInvoiceDraft(input).lines;
    expect(line?.unitPrice).toBe(0);
    expect(line?.amount).toBe(0);
  });

  it("PRICE_NOT_FOUND の警告が件数つきで出る", () => {
    const draft = buildInvoiceDraft(input);
    expect(draft.warnings).toEqual([
      {
        code: "PRICE_NOT_FOUND",
        propertyId: "prop_tokyo",
        taskType: "CHECKOUT",
        roomTypeId: "rt_single",
        taskCount: 12,
      },
    ]);
  });

  it("料金設定のある行と混在しても、ある行の金額は正しい", () => {
    const draft = buildInvoiceDraft({
      tasks: [
        ...tasks(10),
        ...tasks(5, { taskType: "DEEP" as const }).map((t) => ({ ...t, taskId: `d_${t.taskId}` })),
      ],
      pricingRules: [rule({ taskType: "CHECKOUT", unitPrice: 3_000 })],
      taxRoundingMode: "FLOOR" as const,
    });
    expect(draft.subtotalAmount).toBe(30_000);
    expect(draft.warnings.map((w) => w.taskType)).toEqual(["DEEP"]);
  });

  it("¥0 明細も税区分に載る（税率は fallbackTaxRate）", () => {
    const draft = buildInvoiceDraft({ ...input, fallbackTaxRate: 8 });
    expect(draft.taxSummaries).toEqual([
      { taxRate: 8, isReducedRate: false, subtotalAmount: 0, taxAmount: 0, totalAmount: 0 },
    ]);
  });
});

describe("buildInvoiceDraft — 品目コードが引けない作業種別", () => {
  it("RECHECK は ADJUSTMENT の ¥0 明細＋警告になる（§2.4 に品目が無い）", () => {
    const draft = buildInvoiceDraft({
      tasks: tasks(3, { taskType: "RECHECK" }),
      pricingRules: [rule({ itemCode: "ADJUSTMENT", unitPrice: 500 })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.lines[0]?.itemCode).toBe("ADJUSTMENT");
    expect(draft.lines[0]?.unitPrice).toBe(0);
    expect(draft.warnings.map((w) => w.code)).toEqual(["ITEM_CODE_NOT_MAPPED"]);
  });
});

describe("buildInvoiceDraft — §3.1 の除外", () => {
  it.each([
    ["CANCELLED"],
    ["BLOCKED"],
    ["IN_PROGRESS"],
    ["AWAITING_INSPECTION"],
    ["NOT_STARTED"],
  ])("%s は計上しない", (status) => {
    const draft = buildInvoiceDraft({
      tasks: tasks(4, { status }),
      pricingRules: [rule({ taskType: "CHECKOUT" })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.lines).toEqual([]);
    expect(draft.warnings).toEqual([
      {
        code: "EXCLUDED",
        propertyId: "prop_tokyo",
        taskType: "CHECKOUT",
        roomTypeId: "rt_single",
        taskCount: 4,
        detail: status,
      },
    ]);
  });

  it("再清掃は既定で計上しない", () => {
    const draft = buildInvoiceDraft({
      tasks: tasks(6, { isRework: true }),
      pricingRules: [rule({ taskType: "CHECKOUT" })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.lines).toEqual([]);
    expect(draft.warnings[0]?.detail).toBe("REWORK_NOT_CHARGEABLE");
  });

  it("chargeRework を立てれば計上する（有償設定）", () => {
    const draft = buildInvoiceDraft({
      tasks: tasks(6, { isRework: true }),
      pricingRules: [rule({ taskType: "CHECKOUT", unitPrice: 1_000 })],
      taxRoundingMode: "FLOOR",
      chargeRework: true,
    });
    expect(draft.subtotalAmount).toBe(6_000);
    expect(draft.warnings).toEqual([]);
  });

  it("除外されたタスクは合計に効かない", () => {
    const draft = buildInvoiceDraft({
      tasks: [...tasks(2), ...tasks(3, { status: "CANCELLED" }).map((t) => ({ ...t, taskId: `c_${t.taskId}` }))],
      pricingRules: [rule({ taskType: "CHECKOUT", unitPrice: 3_000 })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.subtotalAmount).toBe(6_000);
  });

  it("対象が 1 件も無ければ明細も税区分も空", () => {
    const draft = buildInvoiceDraft({
      tasks: [],
      pricingRules: [rule({})],
      taxRoundingMode: "FLOOR",
    });
    expect(draft).toMatchObject({
      lines: [],
      taxSummaries: [],
      subtotalAmount: 0,
      taxAmount: 0,
      totalAmount: 0,
      warnings: [],
    });
  });
});

describe("buildInvoiceDraft — 端数処理は税率ごとに 1 回だけ（§2.5 MUST）", () => {
  const mixed = {
    tasks: [
      ...tasks(3, { taskType: "CHECKOUT" as const }),
      ...tasks(3, { taskType: "DEEP" as const }).map((t) => ({ ...t, taskId: `d_${t.taskId}` })),
    ],
    pricingRules: [
      rule({ id: "co", taskType: "CHECKOUT", unitPrice: 335 }),
      rule({ id: "dp", taskType: "DEEP", itemCode: "CLEAN_DEEP", unitPrice: 335 }),
    ],
    taxRoundingMode: "FLOOR" as const,
  };

  it("2 行を合計してから 1 回丸める", () => {
    const draft = buildInvoiceDraft(mixed);
    // 335 × 3 = 1,005 が 2 行 → 2,010 × 10% = 201
    expect(draft.subtotalAmount).toBe(2_010);
    expect(draft.taxAmount).toBe(201);
    // 行ごとに丸めていたら 100 × 2 = 200 になる。**その値ではない。**
    expect(draft.taxAmount).not.toBe(200);
  });

  it("明細行に税額の列を持たない（§2.5 の置き場所は taxSummaries）", () => {
    const [line] = buildInvoiceDraft(mixed).lines;
    expect(line).not.toHaveProperty("taxAmount");
  });

  it("税率が混ざれば税区分が 2 行になる", () => {
    const draft = buildInvoiceDraft({
      ...mixed,
      pricingRules: [
        rule({ id: "co", taskType: "CHECKOUT", unitPrice: 1_000 }),
        rule({
          id: "dp",
          taskType: "DEEP",
          itemCode: "CLEAN_DEEP",
          unitPrice: 1_000,
          taxRate: 8,
          isReducedRate: true,
        }),
      ],
    });
    expect(draft.taxSummaries.map((s) => s.taxRate)).toEqual([10, 8]);
    expect(draft.taxAmount).toBe(300 + 240);
  });

  it.each([
    ["FLOOR", 100],
    ["CEIL", 101],
    ["ROUND", 101],
  ] as const)("%s の丸めが効く", (mode, expected) => {
    const draft = buildInvoiceDraft({
      tasks: tasks(1),
      pricingRules: [rule({ taskType: "CHECKOUT", unitPrice: 1_005 })],
      taxRoundingMode: mode,
    });
    expect(draft.taxAmount).toBe(expected);
  });
});

describe("buildInvoiceDraft — 証跡へのドリルダウン（§6.3 / P5-13）", () => {
  it("sourceRef に集計元のタスク ID が全件残る", () => {
    const draft = buildInvoiceDraft({
      tasks: tasks(5),
      pricingRules: [rule({ taskType: "CHECKOUT" })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.lines[0]?.sourceRef.taskIds).toHaveLength(5);
    expect(draft.lines[0]?.sourceRef.taskIds).toEqual([
      "task_0000",
      "task_0001",
      "task_0002",
      "task_0003",
      "task_0004",
    ]);
  });

  it("採用した料金設定と段が残る（なぜその単価かを後から言える）", () => {
    const draft = buildInvoiceDraft({
      tasks: tasks(1),
      pricingRules: [rule({ id: "picked", propertyId: "prop_tokyo", taskType: "CHECKOUT" })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.lines[0]?.sourceRef).toMatchObject({ pricingRuleId: "picked", pricingStage: 2 });
  });

  it("役務提供日は集計対象の最初と最後（§1.1 の 2 番）", () => {
    const draft = buildInvoiceDraft({
      tasks: [
        task({ taskId: "a", businessDate: "2026-09-20" }),
        task({ taskId: "b", businessDate: "2026-09-01" }),
        task({ taskId: "c", businessDate: "2026-09-30" }),
      ],
      pricingRules: [rule({ taskType: "CHECKOUT" })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.lines[0]?.serviceDateFrom).toBe("2026-09-01");
    expect(draft.lines[0]?.serviceDateTo).toBe("2026-09-30");
  });

  it("期間の途中で値上げがあれば新しい単価を採る", () => {
    const draft = buildInvoiceDraft({
      tasks: [
        task({ taskId: "a", businessDate: "2026-09-01" }),
        task({ taskId: "b", businessDate: "2026-09-30" }),
      ],
      pricingRules: [
        rule({ id: "old", taskType: "CHECKOUT", unitPrice: 3_000, validTo: "2026-09-14" }),
        rule({ id: "new", taskType: "CHECKOUT", unitPrice: 3_300, validFrom: "2026-09-15" }),
      ],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.lines[0]?.unitPrice).toBe(3_300);
  });
});

describe("buildInvoiceDraft — 金額はすべて整数（billing.md §4 MUST）", () => {
  it("明細・税区分・合計のすべてが整数", () => {
    const draft = buildInvoiceDraft({
      tasks: [
        ...tasks(7),
        ...tasks(11, { taskType: "STAYOVER" as const }).map((t) => ({ ...t, taskId: `s_${t.taskId}` })),
      ],
      pricingRules: [
        rule({ taskType: "CHECKOUT", unitPrice: 3_333 }),
        rule({ id: "s", taskType: "STAYOVER", itemCode: "CLEAN_STAYOVER", unitPrice: 1_777 }),
      ],
      taxRoundingMode: "ROUND",
    });

    for (const line of draft.lines) {
      expect(Number.isInteger(line.unitPrice)).toBe(true);
      expect(Number.isInteger(line.amount)).toBe(true);
    }
    for (const summary of draft.taxSummaries) {
      expect(Number.isInteger(summary.subtotalAmount)).toBe(true);
      expect(Number.isInteger(summary.taxAmount)).toBe(true);
      expect(Number.isInteger(summary.totalAmount)).toBe(true);
    }
    expect(Number.isInteger(draft.subtotalAmount)).toBe(true);
    expect(Number.isInteger(draft.taxAmount)).toBe(true);
    expect(Number.isInteger(draft.totalAmount)).toBe(true);
  });

  it("税込合計 = 税抜合計 + 税額", () => {
    const draft = buildInvoiceDraft({
      tasks: tasks(9),
      pricingRules: [rule({ taskType: "CHECKOUT", unitPrice: 2_999 })],
      taxRoundingMode: "FLOOR",
    });
    expect(draft.totalAmount).toBe(draft.subtotalAmount + draft.taxAmount);
  });
});
