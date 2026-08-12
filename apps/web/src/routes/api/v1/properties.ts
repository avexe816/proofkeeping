/**
 * 施設サマリー（PK-SPEC-P0 §23.3）。
 *
 *   GET /api/v1/properties/summary?businessDate=2026-08-10
 *
 * task: docs/tasks/P0-21.md
 *
 * ── 1 リクエストで全施設ぶん ────────────────────────────
 * 施設ごとに叩かせない（§23.3 MUST）。**ロールに応じて返す施設を絞る。
 * クライアント側でフィルタしない。** 絞りは第 1 層（`listSelectableProperties()`）
 * が行うので、ここに条件を書かない。
 *
 * ── 集計元は rollup だけ ────────────────────────────────
 * §26 の絶対ルール。`lib/property/summary.ts` の注記を参照。
 */

import { businessDateSchema, type PropertySummaryResponse } from "@pk/contracts";
import { Hono } from "hono";

import { businessDateOf } from "../../../lib/businessDate.js";
import { getPropertySummaries } from "../../../lib/property/summary.js";
import { getNow, getTenant, type AppEnv } from "../../../middleware/index.js";

const properties = new Hono<AppEnv>();

properties.get("/summary", async (c) => {
  const raw = c.req.query("businessDate");
  // 未指定なら「いまの業務日」。**施設ごとの日締め時刻は見ていない。**
  // 施設をまたいで 1 つの日付で返す口なので、組織の既定で決める。
  // 施設別の日締めを反映するのは、施設 1 件の画面（P1）の仕事。
  const parsed = raw === undefined ? undefined : businessDateSchema.safeParse(raw);
  if (parsed !== undefined && !parsed.success) {
    return c.json({ error: "INVALID_REQUEST" as const }, 400);
  }
  const businessDate = parsed?.data ?? businessDateOf(getNow(c));

  const summaries = await getPropertySummaries(c.env, getTenant(c), businessDate);
  const body: PropertySummaryResponse = { businessDate, data: [...summaries] };
  return c.json(body);
});

export default properties;
