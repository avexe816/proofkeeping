/**
 * tenant isolation: inspection / inspection_item_result /
 *                   inspection_photo / rework_cycle
 *
 * task:  docs/tasks/P2-04.md
 * ルール: .claude/rules/testing.md §2
 *
 * 4 表とも `organizationId` と `propertyId` を自前で持つ（P2-01 /
 * DECISIONS #060）。親を辿らずに第 1 層が掛かることをここで固定する。
 */

import {
  type TenantContext,
  findInspectionById,
  findInspectionItemResultById,
  listInspectionItemResults,
  listInspectionPhotos,
  listInspectionsByTask,
  listReworkCyclesByTask,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/**
 * その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。**
 *
 * スイートは同じ `list` を A / B 両方の文脈で呼ぶ（第 3 パターン）。
 * 固定の ID を渡すと片方で `assertIdBelongsToTenant()` が先に落ち、
 * 組織条件を確かめられない。**越境 ID そのものの検査は第 2 パターン
 * （`findById`）が担う。**
 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "inspection",
  list: (env, ctx) => listInspectionsByTask(env, ctx, ownId(ctx, "task")),
  findById: (env, ctx, id) => findInspectionById(env, ctx, id),
  entityPrefix: "insp",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "inspection_item_result",
  list: (env, ctx) => listInspectionItemResults(env, ctx, ownId(ctx, "insp")),
  findById: (env, ctx, id) => findInspectionItemResultById(env, ctx, id),
  entityPrefix: "ires",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "inspection_photo",
  list: (env, ctx) => listInspectionPhotos(env, ctx, ownId(ctx, "insp")),
  // `clientId` は自己記述 ID ではない（端末が採番した uuid）。
  // **越境 ID の検査に使えない**ので `findById` を渡さない。
  // `findInspectionPhotoByClientId()` の組織条件は
  // `repositories.spec.ts` の登録表が押さえている。
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "rework_cycle",
  list: (env, ctx) => listReworkCyclesByTask(env, ctx, ownId(ctx, "task")),
  propertyColumn: "property_id",
});
