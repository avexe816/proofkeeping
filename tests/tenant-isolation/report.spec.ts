/**
 * tenant isolation: lost_item / lost_item_photo / lost_item_history /
 *                   issue_report / issue_photo / issue_history
 *
 * task:  docs/tasks/P2-11.md, docs/tasks/P2-12.md
 * ルール: .claude/rules/testing.md §2
 *
 * 6 表とも `organizationId` と `propertyId` を自前で持つ（`schema/report.ts`）。
 * 親を辿らずに第 1 層が掛かることをここで固定する。
 */

import {
  type TenantContext,
  findIssueReportById,
  findLostItemById,
  listIssueHistory,
  listIssuePhotos,
  listIssueReports,
  listLostItemHistory,
  listLostItemPhotos,
  listLostItems,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/**
 * その文脈の組織に属する ID。**別組織の ID を渡すと第 2 層が先に落とす。**
 *
 * 理由は `inspection.spec.ts` の同名関数と同じ。
 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "lost_item",
  list: (env, ctx) => listLostItems(env, ctx, { propertyId: ownId(ctx, "prop") }),
  findById: (env, ctx, id) => findLostItemById(env, ctx, id),
  entityPrefix: "lost",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "lost_item_photo",
  list: (env, ctx) => listLostItemPhotos(env, ctx, ownId(ctx, "lost")),
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "lost_item_history",
  list: (env, ctx) => listLostItemHistory(env, ctx, ownId(ctx, "lost")),
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "issue_report",
  list: (env, ctx) => listIssueReports(env, ctx, { propertyId: ownId(ctx, "prop") }),
  findById: (env, ctx, id) => findIssueReportById(env, ctx, id),
  entityPrefix: "issue",
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "issue_photo",
  list: (env, ctx) => listIssuePhotos(env, ctx, ownId(ctx, "issue")),
  propertyColumn: "property_id",
});

describeTenantIsolation({
  table: "issue_history",
  list: (env, ctx) => listIssueHistory(env, ctx, ownId(ctx, "issue")),
  propertyColumn: "property_id",
});
