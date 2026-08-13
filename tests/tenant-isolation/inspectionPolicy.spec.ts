/**
 * tenant isolation: property_inspection_policy
 *
 * task:  docs/tasks/P2-01.md / docs/tasks/P2-02.md
 * ルール: .claude/rules/testing.md §2
 */

import { listInspectionPolicies, findInspectionPolicy } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "property_inspection_policy",
  list: (env, ctx) => listInspectionPolicies(env, ctx),
  findById: (env, ctx, id) => findInspectionPolicy(env, ctx, id),
  entityPrefix: "prop",
  propertyColumn: "property_id",
});
