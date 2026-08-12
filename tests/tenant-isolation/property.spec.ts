/**
 * tenant isolation: property
 *
 * task: docs/tasks/P0-13.md
 *
 * この表だけは施設スコープの絞り込みが `property.id`（他の表は `property_id`）。
 * 施設スコープロールは担当外の施設を**一覧でも単体でも**取得できない。
 */

import { findPropertyById, listProperties, listRoomTypes, type TenantContext } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

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
describeTenantIsolation({
  table: "room_type",
  list: (env, ctx) => listRoomTypes(env, ctx, ownProperty(ctx)),
  findById: (env, ctx, id) => listRoomTypes(env, ctx, id),
  entityPrefix: "prop",
  propertyColumn: "property_id",
});
