/**
 * tenant isolation: daily_property_rollup
 *
 * task: docs/tasks/P0-21.md（雛形は P0-13）
 *
 * 施設サマリーの唯一の出どころなので、**ここが漏れると
 * 他組織の稼働状況が読める。** `findById` は主キーではなく
 * 施設 ID で引く（この表に単体取得の API が無いため）。
 */

import { findPropertyRollup, listPropertyRollups, listRollupsInRange } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "daily_property_rollup",
  list: (env, ctx) => listPropertyRollups(env, ctx, "2026-08-12"),
  findById: (env, ctx, id) => findPropertyRollup(env, ctx, id, "2026-08-12"),
  entityPrefix: "prop",
  propertyColumn: "property_id",
});

/**
 * 月次の読み口（P5-14）。**同じ表だが別の関数。**
 *
 * 組織ダッシュボード（PK-SPEC-P5 §7.1）はこちらを通る。単日の
 * `listPropertyRollups()` に条件が載っていても、期間版に載っていなければ
 * **月次の画面だけが他組織の稼働を見せる。** 別々に固定する。
 */
describeTenantIsolation({
  table: "daily_property_rollup (期間)",
  list: (env, ctx) => listRollupsInRange(env, ctx, { from: "2026-08-01", to: "2026-08-31" }),
  propertyColumn: "property_id",
});
