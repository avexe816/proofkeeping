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

import {
  monthSchema,
  type OrgDashboardResponse,
  type VendorPlanResponse,
} from "@pk/contracts";
import { isOrgWideRole } from "@pk/db";
import { Hono } from "hono";

import { ORGANIZATION_TARGET, assertPermission } from "../../../lib/auth/permission.js";
import { buildOrgDashboard, currentMonthOf } from "../../../lib/dashboard/org.js";
import { buildVendorPlan } from "../../../lib/dashboard/vendor.js";
import { assertEntitlement } from "../../../lib/entitlement.js";
import { getNow, getTenant, type AppEnv } from "../../../middleware/index.js";

const dashboard = new Hono<AppEnv>();

/**
 * 対象月。未指定なら業務日の月。**形が違えば 400。**
 *
 * §7.1 と §7.2 で同じ扱いにする（画面が 2 つあっても月の解釈は 1 つ）。
 * `null` は「形が違う」の意味。
 */
function monthOf(raw: string | undefined, now: Date): string | null {
  if (raw === undefined) return currentMonthOf(now);
  const parsed = monthSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

dashboard.get("/org", async (c) => {
  const ctx = getTenant(c);
  if (!isOrgWideRole(ctx.role)) {
    return c.json({ error: "FORBIDDEN" as const }, 403);
  }

  const month = monthOf(c.req.query("month"), getNow(c));
  if (month === null) return c.json({ error: "INVALID_REQUEST" as const }, 400);

  const body: OrgDashboardResponse = await buildOrgDashboard(c.env, ctx, month);
  return c.json(body);
});

/**
 * 清掃会社プラン（§7.2）。
 *
 *   GET /api/v1/dashboard/vendor?month=2026-09
 *
 * ── 権限 → 契約の順（P0-12）───────────────────────────
 * `billing.read` が無いロール（`INSPECTOR` / `CLEANER` / `VENDOR_ADMIN`）は
 * **404。** 請求情報を見られない（security.md §1）。そのうえで
 * `VENDOR_PLAN` モジュールが未契約なら 402。**逆にすると、請求を見られない
 * ロールに対して「契約していない」と答えることになり、402 が資源の存在を
 * 示唆する**（`lib/entitlement.ts` の注記）。
 *
 * ── 全社ビューを持たないロールも 404（§7.1 と違う）──────
 * `/org` は `isOrgWideRole()` で 403 を返すが、ここは**判定を 1 つに
 * まとめてある。** `billing.read` を**組織全体**の対象で問うと、
 * `PROPERTY_MANAGER`（担当施設のみ）は通らない。この画面は受託施設を
 * 横断して組織平均と比べるもので、担当施設だけを出しても「組織平均の
 * 85%」が意味を成さない（§7.2 MUST）。**同じことを 2 か所で判定して
 * 片方だけ緩む形を作らない。** 結果は 404 になるが、`billing.read` を
 * 持たないロールが受け取る応答と揃っており、こちらのほうが漏れが少ない。
 */
dashboard.get("/vendor", async (c) => {
  const ctx = getTenant(c);
  assertPermission(ctx, "billing.read", ORGANIZATION_TARGET);
  await assertEntitlement(c.env, ctx, "VENDOR_PLAN", null);

  const month = monthOf(c.req.query("month"), getNow(c));
  if (month === null) return c.json({ error: "INVALID_REQUEST" as const }, 400);

  const body: VendorPlanResponse = await buildVendorPlan(c.env, ctx, month);
  return c.json(body);
});

export default dashboard;
