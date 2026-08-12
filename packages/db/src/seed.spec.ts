/**
 * シードの検査。
 *
 * task:  docs/tasks/P0-18.md
 * ルール: .claude/rules/testing.md §4（3 回実行しても結果が変わらない）
 *
 * 実 D1 ではなく発行 SQL を見る（P0-02 が未完のため。P0-07 / P0-13 と同じ）。
 * **件数と冪等性はこの形で確かめられる。** 実 DB への投入は P0-02 の完了後。
 */

import { describe, expect, it } from "vitest";

import {
  SEED_CLEANER_COUNT,
  SEED_ORG_SHORT_ID,
  seed,
  type SeedDeps,
} from "./seed.js";
import { createFakeD1, createFakeEnv, type FakeD1 } from "./test-support/fake-d1.js";
import type { Env } from "./env.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");

/** ハッシュ化の代役。**決定的**にして冪等性の検証を邪魔しない。 */
const DEPS: SeedDeps = {
  hashPassword: (password) => Promise.resolve(`pbkdf2$fake$${password}`),
  hashPin: (pin) => Promise.resolve(`pbkdf2$fake$${pin}`),
};

const CREDENTIALS = { ownerPassword: "SeedPassw0rd" };

function seedEnv(overrides: Partial<Env> = {}): { env: Env; fake: FakeD1 } {
  const fake = createFakeD1();
  return { env: { ...createFakeEnv(fake), ...overrides }, fake };
}

/** テーブル名ごとの INSERT 件数。 */
function insertCounts(fake: FakeD1): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const query of fake.queries) {
    const matched = /^insert into "([a-z_]+)"/i.exec(query.sql.trim());
    if (matched === null) continue;
    const table = matched[1] ?? "";
    counts[table] = (counts[table] ?? 0) + 1;
  }
  return counts;
}

describe("seed", () => {
  it("3 施設 120 室・清掃スタッフ 15 名を投入する", async () => {
    const { env, fake } = seedEnv();
    const result = await seed(env, DEPS, CREDENTIALS, NOW);

    expect(result.properties).toBe(3);
    expect(result.rooms).toBe(120);
    expect(result.cleaners).toBe(15);
    expect(result.cleaners).toBe(SEED_CLEANER_COUNT);

    const counts = insertCounts(fake);
    expect(counts["property"]).toBe(3);
    // 客室 120 室 + 清掃専用 3 室（isSellable = false）。
    expect(counts["room"]).toBe(123);
    // 管理者 1 名 + 清掃スタッフ 15 名。
    expect(counts["user"]).toBe(16);
    expect(counts["membership"]).toBe(16);
    expect(counts["property_assignment"]).toBe(15);
  });

  it("清掃専用の場所を客室数に数えない（§24.3）", async () => {
    const { env, fake } = seedEnv();
    const result = await seed(env, DEPS, CREDENTIALS, NOW);

    // 清掃専用の場所は部屋番号を B01 / B02 / B03 で入れてある。
    const nonSellable = fake.queries.filter(
      (query) =>
        /^insert into "room"/i.test(query.sql.trim()) &&
        query.params.some((param) => typeof param === "string" && /^B0\d$/.test(param)),
    );
    expect(nonSellable).toHaveLength(3);
    // 合計 123 行のうち 120 だけが客室として数えられる。
    expect(result.rooms).toBe(120);
  });

  it("3 回連続実行しても同じ SQL とパラメータになる", async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const { env, fake } = seedEnv();
      await seed(env, DEPS, CREDENTIALS, NOW);
      runs.push(JSON.stringify(fake.queries));
    }
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });

  it("全 INSERT が衝突時に何もしない（2 回目で行が増えない）", async () => {
    const { env, fake } = seedEnv();
    await seed(env, DEPS, CREDENTIALS, NOW);

    const inserts = fake.queries.filter((query) => /^insert into/i.test(query.sql.trim()));
    expect(inserts.length).toBeGreaterThan(0);
    for (const query of inserts) {
      // org_directory の予約だけは別経路（例外を捕捉して冪等にしている）。
      if (/"org_directory"/.test(query.sql)) continue;
      expect(query.sql, query.sql).toMatch(/on conflict do nothing/i);
    }
  });

  it("production では実行できない", async () => {
    const { env } = seedEnv({ ENVIRONMENT: "production" });
    await expect(seed(env, DEPS, CREDENTIALS, NOW)).rejects.toThrow(
      "SEED_FORBIDDEN_IN_PRODUCTION",
    );
  });

  it.each(["local", "preview", "staging"] as const)("%s では実行できる", async (environment) => {
    const { env } = seedEnv({ ENVIRONMENT: environment });
    await expect(seed(env, DEPS, CREDENTIALS, NOW)).resolves.toMatchObject({ rooms: 120 });
  });

  it("PIN は連番・ゾロ目でない（pinSchema を通る）", async () => {
    // 通らない PIN が表に混ざったら seed() 自体が落ちる。
    const { env } = seedEnv();
    await expect(seed(env, DEPS, CREDENTIALS, NOW)).resolves.toBeDefined();
  });

  it("PIN を平文で保存しない", async () => {
    const { env, fake } = seedEnv();
    await seed(env, DEPS, CREDENTIALS, NOW);

    const serialized = JSON.stringify(fake.queries);
    expect(serialized).toContain("pbkdf2$fake$");
    // 生の 4 桁がパラメータに現れない。
    for (const query of fake.queries) {
      for (const param of query.params) {
        expect(param).not.toBe("2739");
      }
    }
  });

  it("ID がシードの orgShortId を持つ（第 2 層の自己記述）", async () => {
    const { env } = seedEnv();
    const result = await seed(env, DEPS, CREDENTIALS, NOW);
    expect(result.orgShortId).toBe(SEED_ORG_SHORT_ID);
    expect(result.organizationId.startsWith(`${SEED_ORG_SHORT_ID}__org_`)).toBe(true);
  });

  it("インボイス登録番号を入れない（未設定時の表示を確かめられるように）", async () => {
    const { env, fake } = seedEnv();
    await seed(env, DEPS, CREDENTIALS, NOW);

    const taxInsert = fake.queries.find((query) =>
      /^insert into "organization_tax_profile"/i.test(query.sql.trim()),
    );
    expect(taxInsert).toBeDefined();
    expect(taxInsert?.params).toContain(null);
  });
});
