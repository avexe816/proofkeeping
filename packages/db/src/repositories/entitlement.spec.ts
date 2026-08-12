/**
 * エンタイトルメントの判定（P0-12）。
 *
 * 仕様: docs/PK-SPEC-P7.md §3.1
 *
 * 組織条件の強制注入と越境 ID は `repositories.spec.ts` が見ている。
 * ここは「どんな条件の SQL を組むか」だけを見る。
 */

import { describe, expect, it } from "vitest";

import { generateId } from "../id.js";
import { createFakeD1, createFakeEnv, TEST_ORG, tenantContext } from "../test-support/fake-d1.js";

import { isModuleEnabled } from "./entitlement.js";

const PROPERTY = generateId(TEST_ORG.orgShortId, "prop");

/** 1 行返す代役。`select({ id })` は raw() を通るので配列の配列で積む。 */
function enqueueOneRow(fake: ReturnType<typeof createFakeD1>): void {
  fake.enqueueRows([[generateId(TEST_ORG.orgShortId, "ent")]]);
}

describe("isModuleEnabled", () => {
  it("行が返れば true", async () => {
    const fake = createFakeD1();
    enqueueOneRow(fake);
    expect(await isModuleEnabled(createFakeEnv(fake), tenantContext(), "AUDIT", null)).toBe(true);
  });

  it("行が無ければ false（未購入 → 呼び出し側が 402）", async () => {
    const fake = createFakeD1();
    expect(await isModuleEnabled(createFakeEnv(fake), tenantContext(), "AUDIT", null)).toBe(false);
  });

  it("組織単位の判定は property_id が NULL の行だけを見る", async () => {
    const fake = createFakeD1();
    await isModuleEnabled(createFakeEnv(fake), tenantContext(), "BILLING", null);

    const query = fake.queries[0];
    expect(query?.sql).toContain('"property_id" is null');
    // 施設 ID との比較を混ぜない。
    expect(query?.params).not.toContain(PROPERTY);
  });

  it("施設単位の判定は組織全体の行も許す（OR）", async () => {
    // schema/billing.ts の決定。「1 行でも isEnabled が真なら許可」。
    const fake = createFakeD1();
    await isModuleEnabled(createFakeEnv(fake), tenantContext(), "AUDIT", PROPERTY);

    const query = fake.queries[0];
    expect(query?.sql).toContain('"property_id" is null or');
    expect(query?.params).toContain(PROPERTY);
  });

  it("有効期間を条件に含める", async () => {
    // トライアル終了後も真を返し続けないこと（PK-SPEC-P7 §2.5）。
    const now = new Date("2026-08-12T00:00:00.000Z");
    const fake = createFakeD1();
    await isModuleEnabled(createFakeEnv(fake), tenantContext({ now }), "AUDIT", null);

    const query = fake.queries[0];
    expect(query?.sql).toContain('"valid_from" is null');
    expect(query?.sql).toContain('"valid_until" is null');
    // 期間の比較に ctx.now が使われる（Date.now() を直接呼ばない / CLAUDE.md §5）。
    expect(query?.params.filter((param) => param === now.getTime())).toHaveLength(2);
  });

  it("isEnabled が真の行だけを見る", async () => {
    const fake = createFakeD1();
    await isModuleEnabled(createFakeEnv(fake), tenantContext(), "AUDIT", null);
    expect(fake.queries[0]?.sql).toContain('"is_enabled" = ?');
  });

  it("施設スコープロールでも property_id IN (...) を立てない", async () => {
    // scopeToProperties() を掛けると、組織全体の行（property_id が NULL）が
    // 条件から外れ、契約が有効なのに全員 402 になる（entitlement.ts の doc）。
    const fake = createFakeD1();
    await isModuleEnabled(
      createFakeEnv(fake),
      tenantContext({ role: "CLEANER", allowedPropertyIds: [PROPERTY] }),
      "HOUSEKEEPING_CORE",
      PROPERTY,
    );
    expect(fake.queries[0]?.sql).not.toContain("in (");
  });

  it("担当施設ゼロの施設スコープロールでも 1 = 0 で潰されない", async () => {
    const fake = createFakeD1();
    enqueueOneRow(fake);
    const enabled = await isModuleEnabled(
      createFakeEnv(fake),
      tenantContext({ role: "CLEANER", allowedPropertyIds: [] }),
      "HOUSEKEEPING_CORE",
      null,
    );
    expect(enabled).toBe(true);
    expect(fake.queries[0]?.sql).not.toContain("1 = 0");
  });
});
