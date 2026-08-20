/**
 * tenant isolation: shift_plan
 *
 * task:  docs/tasks/P8-03.md
 * ルール: .claude/rules/testing.md §2 / .claude/rules/security.md §5
 *
 * シフトは雇用管理の個人情報（誰がいつ働くか）。1 行でも混ざれば、
 * 他社スタッフの勤務予定が自社の画面に載る。
 *
 * ── 施設スコープを掛けていない ──────────────────────────
 * 休み（`OFF` など）の行は `property_id` を持たない。施設スコープを
 * 掛けると休みが消えるため `NO_PROPERTY_SCOPE`（`payout.spec.ts` と同じ形）。
 * `propertyColumn: null` を明示する。
 */

import { listShifts } from "@pk/db";

import { describeTenantIsolation } from "./isolation-suite.js";

describeTenantIsolation({
  table: "shift_plan",
  list: (env, ctx) => listShifts(env, ctx, { from: "2026-08-17", to: "2026-08-23" }),
  entityPrefix: "shift",
  propertyColumn: null,
});
