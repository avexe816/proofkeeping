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

import { isModuleEnabled, listEnabledModules } from "./entitlement.js";

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

/**
 * 契約済みモジュールの一覧（P0-14 — ナビゲーションのグレー表示）。
 *
 * **`isModuleEnabled()` と同じ条件を組むこと**が要点。ずれると
 * 「グレーなのに 402 が出ない」「押せるのに 402」が生まれる。
 */
describe("listEnabledModules", () => {
  it("返った行のモジュールを配列で返す", async () => {
    const fake = createFakeD1();
    fake.enqueueRows([["HOUSEKEEPING_CORE"], ["AUDIT"]]);

    const modules = await listEnabledModules(createFakeEnv(fake), tenantContext(), null);

    expect(modules).toEqual(["HOUSEKEEPING_CORE", "AUDIT"]);
  });

  it("組織全体の行と施設単位の行で重複したモジュールを畳む", async () => {
    // 判定が OR なので同じモジュールが 2 行立ちうる（schema/billing.ts）。
    const fake = createFakeD1();
    fake.enqueueRows([["AUDIT"], ["AUDIT"], ["BILLING"]]);

    const modules = await listEnabledModules(createFakeEnv(fake), tenantContext(), PROPERTY);

    expect(modules).toEqual(["AUDIT", "BILLING"]);
  });

  it("1 行も無ければ空配列（全項目がグレーになる）", async () => {
    const fake = createFakeD1();
    expect(await listEnabledModules(createFakeEnv(fake), tenantContext(), null)).toEqual([]);
  });

  it("moduleCode で絞らない（一覧なので全モジュールを見る）", async () => {
    const fake = createFakeD1();
    await listEnabledModules(createFakeEnv(fake), tenantContext(), null);

    expect(fake.queries[0]?.sql).not.toContain('"module_code" = ?');
  });

  it("isModuleEnabled と同じ施設条件・期間条件を組む", async () => {
    const now = new Date("2026-08-12T00:00:00.000Z");
    const fake = createFakeD1();
    await listEnabledModules(createFakeEnv(fake), tenantContext({ now }), PROPERTY);

    const query = fake.queries[0];
    expect(query?.sql).toContain('"property_id" is null or');
    expect(query?.sql).toContain('"is_enabled" = ?');
    expect(query?.sql).toContain('"valid_from" is null');
    expect(query?.sql).toContain('"valid_until" is null');
    expect(query?.params).toContain(PROPERTY);
    expect(query?.params.filter((param) => param === now.getTime())).toHaveLength(2);
  });

  it("施設スコープロールでも property_id IN (...) を立てない", async () => {
    const fake = createFakeD1();
    await listEnabledModules(
      createFakeEnv(fake),
      tenantContext({ role: "CLEANER", allowedPropertyIds: [PROPERTY] }),
      PROPERTY,
    );
    expect(fake.queries[0]?.sql).not.toContain("in (");
  });

  it("別組織の施設 ID は DB へ行く前に落とす", async () => {
    const fake = createFakeD1();

    await expect(
      listEnabledModules(createFakeEnv(fake), tenantContext(), "zz9zz9__prop_other"),
    ).rejects.toThrow();
    expect(fake.queries).toHaveLength(0);
  });
});
