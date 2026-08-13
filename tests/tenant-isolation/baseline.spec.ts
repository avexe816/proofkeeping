/**
 * tenant isolation: consumption_baseline / baseline_exclusion_log
 *
 * task:  docs/tasks/P3-09.md, P3-10.md, P3-12.md
 * ルール: .claude/rules/testing.md §2
 *
 * どちらの表も `organizationId` と `propertyId` を自前で持つ
 * （`schema/observation.ts` の注記④）。親を辿らずに第 1 層が掛かることを
 * ここで固定する。
 *
 * **ベースラインは P4 の照合の閾値そのもの。** 別組織の値が混ざると、
 * 他社の消耗傾向で自社の差異が出る。第 3 パターン（同一シャードの
 * 組織ペア）が効いているのはここ。
 */

import {
  type TenantContext,
  findBaselineById,
  listBaselineExclusions,
  listBaselines,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/**
 * その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。**
 *
 * 理由は `observation.spec.ts` の同名関数と同じ。
 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "consumption_baseline",
  list: (env, ctx) => listBaselines(env, ctx, { propertyId: ownId(ctx, "prop") }),
  findById: (env, ctx, id) => findBaselineById(env, ctx, id),
  entityPrefix: "bsln",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "baseline_exclusion_log",
  list: (env, ctx) => listBaselineExclusions(env, ctx, { propertyId: ownId(ctx, "prop") }),
  propertyColumn: "property_id",
});
