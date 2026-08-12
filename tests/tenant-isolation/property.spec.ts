/**
 * tenant isolation: property
 *
 * task: docs/tasks/P0-13.md
 *
 * この表だけは施設スコープの絞り込みが `property.id`（他の表は `property_id`）。
 * 施設スコープロールは担当外の施設を**一覧でも単体でも**取得できない。
 */

import { findPropertyById, listProperties } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "property",
  list: (env, ctx) => listProperties(env, ctx, {}),
  findById: (env, ctx, id) => findPropertyById(env, ctx, id),
  entityPrefix: "prop",
  propertyColumn: "id",
});
