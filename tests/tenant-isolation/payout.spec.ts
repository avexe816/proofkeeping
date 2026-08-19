/**
 * tenant isolation: staff_pay_profile / pay_rule / payout_period / payout_line
 *
 * task:  docs/tasks/P5-18.md
 * ルール: .claude/rules/testing.md §2 / .claude/rules/security.md §5
 *
 * **支払が 1 行でも混ざれば、他社スタッフの支払額（雇用管理の個人情報 /
 * security.md §5）が自社の画面に載る。** 請求（invoice.spec.ts）と同じく
 * 第 3 パターン（同一シャードの組織ペア）が効く場所。
 *
 * ── 施設スコープを掛けていない ──────────────────────────
 * 4 表とも `NO_PROPERTY_SCOPE`（`pay_rule.property_id` / `payout_line.
 * property_id` は null = 全施設・調整行を取りうる列で、施設スコープを
 * 掛けると「全施設」の行が消える）。到達の制限は `payout.read` /
 * `payout.write`（OWNER / ORG_ADMIN のみ）が担う。**`propertyColumn: null`
 * を明示する**（invoice.spec.ts と同じ形）。
 */

import {
  findPayoutPeriodById,
  listPayoutLines,
  listPayoutPeriods,
  listPayRules,
  listStaffPayProfiles,
  type TenantContext,
} from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

/** その文脈の組織に属する ID（`occupancy.spec.ts` の同名関数と同じ理由）。 */
function ownId(ctx: TenantContext, prefix: string): string {
  return `${ctx.orgShortId}__${prefix}_01JBXQ3ZK8N4P2VYR6ABCDEFGH`;
}

describeTenantIsolation({
  table: "staff_pay_profile",
  list: (env, ctx) => listStaffPayProfiles(env, ctx),
  entityPrefix: "sppf",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "pay_rule",
  list: (env, ctx) => listPayRules(env, ctx, { membershipId: ownId(ctx, "mem") }),
  entityPrefix: "payr",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "payout_period",
  list: (env, ctx) => listPayoutPeriods(env, ctx, { membershipId: ownId(ctx, "mem") }),
  findById: (env, ctx, id) => findPayoutPeriodById(env, ctx, id),
  entityPrefix: "pout",
  propertyColumn: null,
});

describeTenantIsolation({
  table: "payout_line",
  list: (env, ctx) => listPayoutLines(env, ctx, ownId(ctx, "pout")),
  entityPrefix: "poln",
  propertyColumn: null,
});
