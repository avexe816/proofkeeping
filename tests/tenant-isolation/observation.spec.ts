/**
 * tenant isolation: room_observation / observation_revision /
 *                   linen_record / observation_config
 *
 * task:  docs/tasks/P3-03.md, P3-06.md, P3-07.md, P3-11.md
 * ルール: .claude/rules/testing.md §2
 *
 * 4 表とも `organizationId` と `propertyId` を自前で持つ
 * （`schema/observation.ts` の注記④）。親を辿らずに第 1 層が掛かることを
 * ここで固定する。
 *
 * **`consumption_baseline` と `baseline_exclusion_log` はまだ無い。**
 * 読み書きの関数を作るのは P3-09 / P3-10 / P3-12 で、それらが
 * `_template.spec.ts` の `UNCOVERED_TABLES` から行を消す。
 */

import {
  type TenantContext,
  findObservationById,
  findObservationConfig,
  listLinenRecords,
  listObservationConfigs,
  listObservationRevisions,
  listObservations,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/**
 * その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。**
 *
 * 理由は `inspection.spec.ts` の同名関数と同じ。
 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "room_observation",
  list: (env, ctx) => listObservations(env, ctx, { propertyId: ownId(ctx, "prop") }),
  findById: (env, ctx, id) => findObservationById(env, ctx, id),
  entityPrefix: "obs",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "observation_revision",
  list: (env, ctx) => listObservationRevisions(env, ctx, ownId(ctx, "obs")),
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "linen_record",
  list: (env, ctx) => listLinenRecords(env, ctx, ownId(ctx, "task")),
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "observation_config",
  list: (env, ctx) => listObservationConfigs(env, ctx, [ownId(ctx, "prop")]),
  findById: (env, ctx, id) => findObservationConfig(env, ctx, id),
  entityPrefix: "prop",
  propertyColumn: "property_id",
});
