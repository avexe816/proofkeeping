/**
 * tenant isolation: reconciliation_run / audit_finding /
 *                   physical_signal / room_access_log / detection_feedback
 *
 * task:  docs/tasks/P4-05.md
 * ルール: .claude/rules/testing.md §2
 *
 * **差異は組織の内部統制そのもの**（PK-SPEC-P4 §1.1）。他社の客室で立った
 * 差異が自社の一覧に 1 件でも混ざれば、説明のつかない指摘を現場へ出すことに
 * なる。第 3 パターン（同一シャードの組織ペア）が効いているのはここ。
 *
 * `rule_config` は施設の次元を任意（`propertyId = null` が組織既定）に持つ
 * 表なので、施設スコープの検査を掛けられない。**組織条件は
 * `repositories.spec.ts` の走査が固定している。**
 */

import {
  findFindingById,
  findReconciliationRunById,
  listFindings,
  listPhysicalSignals,
  listRecentFalsePositives,
  listReconciliationRuns,
  listRoomAccessLogs,
  type TenantContext,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/**
 * その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。**
 *
 * 理由は `occupancy.spec.ts` の同名関数と同じ。
 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "reconciliation_run",
  list: (env, ctx) => listReconciliationRuns(env, ctx, { propertyId: ownId(ctx, "prop") }),
  findById: (env, ctx, id) => findReconciliationRunById(env, ctx, id),
  entityPrefix: "run",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "audit_finding",
  list: (env, ctx) => listFindings(env, ctx, { propertyId: ownId(ctx, "prop") }),
  findById: (env, ctx, id) => findFindingById(env, ctx, id),
  entityPrefix: "find",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "physical_signal",
  list: (env, ctx) =>
    listPhysicalSignals(env, ctx, {
      propertyId: ownId(ctx, "prop"),
      businessDate: "2026-09-09",
    }),
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "room_access_log",
  list: (env, ctx) =>
    listRoomAccessLogs(env, ctx, {
      propertyId: ownId(ctx, "prop"),
      businessDate: "2026-09-09",
    }),
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "detection_feedback",
  list: (env, ctx) =>
    listRecentFalsePositives(env, ctx, {
      propertyId: ownId(ctx, "prop"),
      from: new Date("2026-08-10T00:00:00Z"),
    }),
  propertyColumn: "property_id",
});
