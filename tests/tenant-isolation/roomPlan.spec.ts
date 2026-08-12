/**
 * tenant isolation: daily_room_plan / standard_time
 *
 * task:  docs/tasks/P1-01.md / docs/tasks/P1-02.md / docs/tasks/P1-04.md
 * ルール: .claude/rules/testing.md §2
 */

import { listRoomPlans, listStandardTimes, type TenantContext } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

function ownProperty(ctx: TenantContext): string {
  return `${ctx.orgShortId}__prop_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "daily_room_plan",
  list: (env, ctx) => listRoomPlans(env, ctx, ownProperty(ctx), "2026-08-12"),
  findById: (env, ctx, id) => listRoomPlans(env, ctx, id, "2026-08-12"),
  entityPrefix: "prop",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "standard_time",
  list: (env, ctx) => listStandardTimes(env, ctx, ownProperty(ctx)),
  findById: (env, ctx, id) => listStandardTimes(env, ctx, id),
  entityPrefix: "prop",
  propertyColumn: "property_id",
});
