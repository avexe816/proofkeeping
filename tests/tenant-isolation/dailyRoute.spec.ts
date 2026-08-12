/**
 * tenant isolation: daily_route
 *
 * task:  docs/tasks/P1-21.md
 * ルール: .claude/rules/testing.md §2
 *
 * ── 施設スコープを掛けない表 ────────────────────────────
 * `propertyColumn: null`。この表は**担当者の 1 日の動線**で、行の主体は
 * 施設ではなく `membershipId`（`repositories/dailyRoute.ts` の注記）。
 * 施設で絞ると担当外施設の行が消え、訪問順に穴が空く。
 * **他人の動線が返らないことは `membershipId` の条件が保証する。**
 * 第 4 パターン（施設スコープ）が飛ぶのはそのため。
 */

import { listDailyRoute, type TenantContext } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

function ownMembership(ctx: TenantContext): string {
  return `${ctx.orgShortId}__mem_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "daily_route",
  list: (env, ctx) => listDailyRoute(env, ctx, ownMembership(ctx), "2026-08-12"),
  findById: (env, ctx, id) => listDailyRoute(env, ctx, id, "2026-08-12"),
  entityPrefix: "mem",
  propertyColumn: null,
});
