/**
 * tenant isolation: cleaning_task / task_time_log / task_photo
 *
 * task:  docs/tasks/P1-01.md
 * ルール: .claude/rules/testing.md §2
 */

import {
  countPhotosByChecklistItem,
  findTaskById,
  listTasks,
  listTimeLogs,
  type TenantContext,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/** その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。** */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "cleaning_task",
  list: (env, ctx) => listTasks(env, ctx, { businessDate: "2026-08-12" }),
  findById: (env, ctx, id) => findTaskById(env, ctx, id),
  entityPrefix: "task",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "task_time_log",
  list: (env, ctx) => listTimeLogs(env, ctx, ownId(ctx, "task")),
  findById: (env, ctx, id) => listTimeLogs(env, ctx, id),
  entityPrefix: "task",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "task_photo",
  list: (env, ctx) => countPhotosByChecklistItem(env, ctx, ownId(ctx, "task")),
  findById: (env, ctx, id) => countPhotosByChecklistItem(env, ctx, id),
  entityPrefix: "task",
  propertyColumn: "property_id",
});
