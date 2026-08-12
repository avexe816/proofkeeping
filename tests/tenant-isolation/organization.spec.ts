/**
 * tenant isolation: organization / organization_tax_profile
 *
 * task: docs/tasks/P0-13.md
 *
 * `organization` は `id === organizationId` で、施設の次元も ID 引数も持たない。
 * 4 パターンのうち第 2（越境 ID → 404）は成立しないので飛ばす。
 */

import { findOrganization, findTaxProfile } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "organization",
  list: (env, ctx) => findOrganization(env, ctx),
  propertyColumn: null,
});

describeTenantIsolation({
  table: "organization_tax_profile",
  list: (env, ctx) => findTaxProfile(env, ctx),
  propertyColumn: null,
});
