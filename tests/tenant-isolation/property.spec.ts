/**
 * tenant isolation: property
 *
 * task: docs/tasks/P0-13.md
 *
 * この表だけは施設スコープの絞り込みが `property.id`（他の表は `property_id`）。
 * 施設スコープロールは担当外の施設を**一覧でも単体でも**取得できない。
 */

import { createFakeD1, createFakeEnv } from "@pk/db/test-support";
import {
  NotFoundError,
  createRoomType,
  findPropertyById,
  findRoomTypeById,
  listProperties,
  listRoomTypes,
  updateRoomType,
  type TenantContext,
} from "@pk/db";
import { describe, expect, it } from "vitest";

import { ORG_A, ORG_B, contextFor, describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "property",
  list: (env, ctx) => listProperties(env, ctx, {}),
  findById: (env, ctx, id) => findPropertyById(env, ctx, id),
  entityPrefix: "prop",
  propertyColumn: "id",
});

/** その組織の施設 ID（`assertIdBelongsToTenant()` を通る形）。 */
function ownProperty(ctx: TenantContext): string {
  return `${ctx.orgShortId}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

// `room_type` は W-05 / W-16 / W-17（P1-02・P1-04・P1-06 の未達分）が
// 読むようになった表。**それまで越境テストが無かった。**
//
// P1-24 で `findById` を `findRoomTypeById()` に差し替えた。それまでは
// 施設 ID を `listRoomTypes()` に渡して代用しており、**「客室タイプの ID を
// 越境して引けないこと」は一度も検査されていなかった**（施設 ID の検査を
// 2 回やっていた形）。
describeTenantIsolation({
  table: "room_type",
  list: (env, ctx) => listRoomTypes(env, ctx, ownProperty(ctx), {}),
  findById: (env, ctx, id) => findRoomTypeById(env, ctx, id),
  entityPrefix: "rtyp",
  propertyColumn: "property_id",
});

/** その組織の客室タイプ ID。 */
function ownRoomType(ctx: TenantContext): string {
  return `${ctx.orgShortId}__rtyp_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

// 書く経路（P1-24）。**読みだけを検査しても第 1 層は半分しか固定されない。**
//
// `UPDATE` は `where` を持つので 4 パターンがそのまま掛かる。
describeTenantIsolation({
  table: "room_type (update)",
  list: (env, ctx) => updateRoomType(env, ctx, ownRoomType(ctx), { name: "ツイン" }),
  findById: (env, ctx, id) => updateRoomType(env, ctx, id, { name: "ツイン" }),
  entityPrefix: "rtyp",
  propertyColumn: "property_id",
});

/**
 * `INSERT` は `where` を持たない。**共通スイートに載せられない。**
 *
 * `describeTenantIsolation()` の 4 パターンのうち 3 つは
 * 「発行された SQL に組織条件と施設スコープの条件が載ること」を見るもので、
 * `INSERT` にはその節が構文として存在しない。載せると「条件が無いから落ちる」
 * だけのテストになり、**共通スイートの意味（条件の書き忘れを止める）が
 * 分からなくなる。** ここでは INSERT で守れる 2 つを直接書く。
 *
 *   ① 越境した `propertyId` は DB へ行く前に 404（第 2 層）
 *   ② 書き込む `organization_id` は必ず `ctx` のもの（第 1 層の強制注入）
 *
 * `UPDATE` 側の 4 パターンは上のスイートが見ている。
 */
describe("tenant isolation: room_type (create)", () => {
  it("別組織の施設 ID を指定すると 404", async () => {
    const fake = createFakeD1();
    const env = createFakeEnv(fake);
    const crossTenantProperty = `${ORG_B.orgShortId}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;

    await expect(
      createRoomType(env, contextFor(ORG_A), {
        propertyId: crossTenantProperty,
        code: "TWN",
        name: "ツイン",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // **DB へ問い合わせる前に落ちること。**
    expect(fake.queries).toEqual([]);
  });

  it("書き込む organization_id は必ず自組織のもの", async () => {
    const fake = createFakeD1();
    const ctx = contextFor(ORG_A);
    await createRoomType(createFakeEnv(fake), ctx, {
      propertyId: ownProperty(ctx),
      code: "TWN",
      name: "ツイン",
    });

    expect(fake.queries.length).toBeGreaterThan(0);
    for (const query of fake.queries) {
      expect(query.sql).toContain('insert into "room_type"');
      expect(query.params).toContain(ORG_A.organizationId);
      expect(query.params).not.toContain(ORG_B.organizationId);
    }
  });

  it("同一シャードに同居する組織の ID が混ざらない", async () => {
    // このテストだけは同一シャードのペアであることに意味がある
    // （別シャードなら物理的に到達不能で、条件を消しても緑のままになる）。
    const fakeA = createFakeD1();
    const fakeB = createFakeD1();
    const ctxA = contextFor(ORG_A);
    const ctxB = contextFor(ORG_B);
    await createRoomType(createFakeEnv(fakeA), ctxA, {
      propertyId: ownProperty(ctxA),
      code: "TWN",
      name: "ツイン",
    });
    await createRoomType(createFakeEnv(fakeB), ctxB, {
      propertyId: ownProperty(ctxB),
      code: "TWN",
      name: "ツイン",
    });

    for (const query of fakeA.queries) {
      expect(query.params).toContain(ORG_A.organizationId);
      expect(query.params).not.toContain(ORG_B.organizationId);
    }
    for (const query of fakeB.queries) {
      expect(query.params).toContain(ORG_B.organizationId);
      expect(query.params).not.toContain(ORG_A.organizationId);
    }
  });

  it("採番される ID の orgShortId が自組織のもの", async () => {
    // 第 2 層（ID の自己記述化）。別組織の文脈でこの ID を渡すと
    // `assertIdBelongsToTenant()` が落とす、という前提を作る側。
    const fake = createFakeD1();
    const ctx = contextFor(ORG_A);
    const result = await createRoomType(createFakeEnv(fake), ctx, {
      propertyId: ownProperty(ctx),
      code: "TWN",
      name: "ツイン",
    });

    expect(result.id.startsWith(`${ORG_A.orgShortId}__rtyp_`)).toBe(true);
  });
});
