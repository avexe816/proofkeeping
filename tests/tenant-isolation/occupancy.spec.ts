/**
 * tenant isolation: occupancy_snapshot
 *
 * task:  docs/tasks/P4-02.md
 * ルール: .claude/rules/testing.md §2
 *
 * **稼働記録は差異の根拠そのもの**（PK-SPEC-P4 §1.2 の A 系統）。
 * 別組織の稼働記録が混ざると、他社の稼働で自社の差異が出る。
 * とくに `isOccupied` が混ざると R001（稼働記録のない使用痕跡）が
 * 根拠のない差異を作る。第 3 パターン（同一シャードの組織ペア）が
 * 効いているのはここ。
 */

import {
  type TenantContext,
  findOccupancySnapshotById,
  listOccupancySnapshots,
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
  table: "occupancy_snapshot",
  list: (env, ctx) =>
    listOccupancySnapshots(env, ctx, {
      propertyId: ownId(ctx, "prop"),
      businessDate: "2026-09-09",
    }),
  findById: (env, ctx, id) => findOccupancySnapshotById(env, ctx, id),
  entityPrefix: "occ",
  propertyColumn: "property_id",
});
