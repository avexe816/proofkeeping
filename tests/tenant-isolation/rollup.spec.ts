/**
 * tenant isolation: daily_property_rollup
 *
 * task: docs/tasks/P0-21.md（雛形は P0-13）
 *
 * 施設サマリーの唯一の出どころなので、**ここが漏れると
 * 他組織の稼働状況が読める。** `findById` は主キーではなく
 * 施設 ID で引く（この表に単体取得の API が無いため）。
 */

import { findPropertyRollup, listPropertyRollups } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "daily_property_rollup",
  list: (env, ctx) => listPropertyRollups(env, ctx, "2026-08-12"),
  findById: (env, ctx, id) => findPropertyRollup(env, ctx, id, "2026-08-12"),
  entityPrefix: "prop",
  propertyColumn: "property_id",
});
