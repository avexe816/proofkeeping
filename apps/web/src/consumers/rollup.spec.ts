/**
 * 日次集計の更新のテスト（P5-14 / PK-SPEC-P0 §19.6）。
 *
 * ルール: .claude/rules/testing.md §4（冪等: 3 回実行しても結果が変わらない）
 *
 * ── どこで何を押さえているか ────────────────────────────
 *   ① メッセージの検証 …… ここ
 *   ② 投入が業務を止めない …… ここ（Queue が落ちても例外にしない）
 *   ③ **冪等** …… ここ。3 回走らせて、書き込む値が変わらないことを
 *      発行 SQL のパラメータで見る。**加算方式なら 2 回目で変わる。**
 *   ④ 組織条件が載ること …… `packages/db/.../repositories.spec.ts`
 */

import { generateId } from "@pk/db";
import { createFakeD1, createFakeEnv, OTHER_ORG, TEST_ORG } from "@pk/db/test-support";
import { describe, expect, it } from "vitest";

import {
  enqueueRollupUpdate,
  isRollupUpdateMessage,
  runRollupUpdate,
  type RollupUpdateMessage,
} from "./rollup.js";

const PROPERTY_ID = generateId(TEST_ORG.orgShortId, "prop");

const MESSAGE: RollupUpdateMessage = {
  kind: "ROLLUP_UPDATE",
  organizationId: TEST_ORG.organizationId,
  orgShortId: TEST_ORG.orgShortId,
  propertyId: PROPERTY_ID,
  businessDate: "2026-09-10",
  reason: "TASK",
};

describe("isRollupUpdateMessage", () => {
  it("正しい形を受け入れる", () => {
    expect(isRollupUpdateMessage(MESSAGE)).toBe(true);
  });

  it("3 つのきっかけをすべて受け入れる", () => {
    for (const reason of ["TASK", "INSPECTION", "RECONCILIATION"] as const) {
      expect(isRollupUpdateMessage({ ...MESSAGE, reason })).toBe(true);
    }
  });

  it("kind が違えば拒む", () => {
    expect(isRollupUpdateMessage({ ...MESSAGE, kind: "RECONCILIATION" })).toBe(false);
  });

  it("欠けた欄があれば拒む", () => {
    const rest: Record<string, unknown> = { ...MESSAGE };
    delete rest["propertyId"];
    expect(isRollupUpdateMessage(rest)).toBe(false);
  });

  it("業務日の形が違えば拒む", () => {
    expect(isRollupUpdateMessage({ ...MESSAGE, businessDate: "2026-09" })).toBe(false);
    expect(isRollupUpdateMessage({ ...MESSAGE, businessDate: "20260910" })).toBe(false);
  });

  it("きっかけが語彙の外なら拒む", () => {
    expect(isRollupUpdateMessage({ ...MESSAGE, reason: "NIGHTLY" })).toBe(false);
  });

  it("オブジェクトでなければ拒む", () => {
    expect(isRollupUpdateMessage(null)).toBe(false);
    expect(isRollupUpdateMessage("ROLLUP_UPDATE")).toBe(false);
  });
});

describe("enqueueRollupUpdate — 投入の失敗で業務を止めない", () => {
  it("メッセージを 1 通送る", async () => {
    const sent: unknown[] = [];
    const env = { QUEUE_ROLLUP_UPDATE: { send: (m: unknown) => { sent.push(m); return Promise.resolve(); } } };

    await enqueueRollupUpdate(env as never, TEST_ORG, {
      propertyId: PROPERTY_ID,
      businessDate: "2026-09-10",
      reason: "INSPECTION",
    });

    expect(sent).toHaveLength(1);
    expect(isRollupUpdateMessage(sent[0])).toBe(true);
    expect((sent[0] as RollupUpdateMessage).reason).toBe("INSPECTION");
  });

  it("Queue が落ちても例外にしない", async () => {
    const env = { QUEUE_ROLLUP_UPDATE: { send: () => Promise.reject(new Error("QUEUE_DOWN")) } };

    await expect(
      enqueueRollupUpdate(env as never, TEST_ORG, {
        propertyId: PROPERTY_ID,
        businessDate: "2026-09-10",
        reason: "TASK",
      }),
    ).resolves.toBeUndefined();
  });
});

/** 発行された UPSERT を 1 本取り出す。 */
function upsertOf(queries: readonly { sql: string; params: unknown[] }[]) {
  const row = queries.find(
    (query) => query.sql.includes("daily_property_rollup") && query.sql.includes("insert"),
  );
  expect(row, "UPSERT が発行されていない").toBeDefined();
  return row as { sql: string; params: unknown[] };
}

describe("runRollupUpdate — 冪等（testing.md §4）", () => {
  it("3 回実行しても書き込む値が変わらない", async () => {
    const now = new Date("2026-09-11T02:00:00.000Z");
    const runs: { sql: string; params: unknown[] }[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fake = createFakeD1();
      const outcome = await runRollupUpdate(createFakeEnv(fake), MESSAGE, now);
      expect(outcome.kind).toBe("DONE");
      runs.push(upsertOf(fake.queries));
    }

    // 行 ID だけは毎回変わる（採番）。**衝突時には捨てられる**ので
    // 結果に影響しない（`upsertPropertyRollup()` の注記）。
    const withoutId = (row: { params: unknown[] }) =>
      row.params.filter((value) => typeof value !== "string" || !value.includes("__roll_"));

    const [first, second, third] = runs.map(withoutId);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("加算していない（`列 = 列 + ?` を発行しない）", async () => {
    const fake = createFakeD1();
    await runRollupUpdate(createFakeEnv(fake), MESSAGE, new Date());

    const { sql } = upsertOf(fake.queries);
    expect(sql).toContain("on conflict");
    // 再計算方式なら、更新側は必ず束縛値の代入だけになる。
    expect(sql).not.toMatch(/"total_tasks"\s*=\s*"?daily_property_rollup"?\."?total_tasks/);
    expect(sql).not.toMatch(/\+\s*\?/);
  });

  it("越境した施設 ID は書き込む前に落ちる", async () => {
    const fake = createFakeD1();
    const outcome = await runRollupUpdate(
      createFakeEnv(fake),
      { ...MESSAGE, propertyId: generateId(OTHER_ORG.orgShortId, "prop") },
      new Date(),
    );

    expect(outcome.kind).toBe("FAILED");
    expect(fake.queries.some((query) => query.sql.includes("insert"))).toBe(false);
  });
});
