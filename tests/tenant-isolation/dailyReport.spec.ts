/**
 * tenant isolation: daily_report
 *
 * task:  docs/tasks/P2-14.md
 * ルール: .claude/rules/testing.md §2
 *
 * 日報は施設ごとの帳票で、`organizationId` と `propertyId` を自前で持つ
 * （`schema/dailyReport.ts`）。**別組織の日報が一覧に混ざると、
 * 客室番号・担当者名・所要時間がそのまま漏れる。**
 */

import { type TenantContext, findDailyReportById, listDailyReports } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/** その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。** */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "daily_report",
  list: (env, ctx) => listDailyReports(env, ctx, { propertyId: ownId(ctx, "prop") }),
  findById: (env, ctx, id) => findDailyReportById(env, ctx, id),
  entityPrefix: "rpt",
  propertyColumn: "property_id",
});
