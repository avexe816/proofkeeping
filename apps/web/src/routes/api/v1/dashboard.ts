/**
 * 組織ダッシュボード（W-02 / PK-SPEC-P5 §7.1）。
 *
 *   GET /api/v1/dashboard/org?month=2026-09
 *
 * task: docs/tasks/P5-14.md
 *
 * ── 口は 1 本だけ ───────────────────────────────────────
 * 全社サマリー・施設別比較・要対応を**1 回で返す。** 3 本に分けると、
 * 画面が 3 往復し、しかも 3 つの数字が別の瞬間のものになる。
 *
 * ── 全社ビューを持たないロールは 403 ────────────────────
 * `PROPERTY_MANAGER` などは組織全体の数字を見られない（§23.5）。
 * **404 ではなく 403。** 経路は資源ではないので、存在を伏せる意味が
 * ない（`switchProperty()` と同じ扱い / architecture.md §2）。
 *
 * ── 集計元は rollup（§7.1 MUST）─────────────────────────
 * 稼働の数字は `dailyPropertyRollup` だけ。金額と要対応の扱いは
 * `lib/dashboard/org.ts` の注記を参照。
 */

import { monthSchema, type OrgDashboardResponse } from "@pk/contracts";
import { isOrgWideRole } from "@pk/db";
import { Hono } from "hono";

import { buildOrgDashboard, currentMonthOf } from "../../../lib/dashboard/org.js";
import { getNow, getTenant, type AppEnv } from "../../../middleware/index.js";

const dashboard = new Hono<AppEnv>();

dashboard.get("/org", async (c) => {
  const ctx = getTenant(c);
  if (!isOrgWideRole(ctx.role)) {
    return c.json({ error: "FORBIDDEN" as const }, 403);
  }

  const raw = c.req.query("month");
  const parsed = raw === undefined ? undefined : monthSchema.safeParse(raw);
  if (parsed !== undefined && !parsed.success) {
    return c.json({ error: "INVALID_REQUEST" as const }, 400);
  }
  const month = parsed?.data ?? currentMonthOf(getNow(c));

  const body: OrgDashboardResponse = await buildOrgDashboard(c.env, ctx, month);
  return c.json(body);
});

export default dashboard;
