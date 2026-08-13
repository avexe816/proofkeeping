/**
 * 観察記録の入力品質の API（PK-SPEC-P3 §7 / W-22）。
 *
 * ```
 * GET /api/v1/data-quality?propertyId=&month=YYYY-MM
 * ```
 *
 * task:  docs/tasks/P3-12.md
 * ルール: .claude/rules/security.md §5（従業員データ）
 *
 * ── 読み取りだけ ────────────────────────────────────────
 * 書き込みの口が無い。品質は観察記録から毎回組み立てるもので、
 * 保存する値ではない（rollup を作らない理由は下）。
 *
 * ── rollup を作っていない ───────────────────────────────
 * 1 施設 1 か月ぶんのタスク・観察・除外を読むので、集計表を挟まずに
 * その場で組み立てる。**月をまたぐ集計・全社集計をこの口へ足さないこと**
 * （architecture.md §3 が rollup を要求するのはそちら）。
 *
 * ── スタッフ別は入力率だけ ──────────────────────────────
 * §6.3 MUST が求める「フォローが必要な人を見つける」ための数字。
 * 20 タスク未満は `display: false`、氏名は `canViewStaffName()` 越し
 * （INV-06 / INV-07）。**所要時間・既定値率をスタッフ別に返さない。**
 */

import { dataQualityMonthSchema, type BaselineError, type DataQualityResponse } from "@pk/contracts";
import { findPropertyById } from "@pk/db";
import { Hono } from "hono";

import { assertPermission, propertyTarget } from "../../../lib/auth/permission.js";
import { collectDataQuality, monthRangeOf } from "../../../lib/baseline/dataQuality.js";
import { getTenant, type AppEnv } from "../../../middleware/index.js";

const dataQuality = new Hono<AppEnv>();

/** 400。**文言を載せない。** 画面が i18n キーへ写す。 */
function invalidRequest(): BaselineError {
  return { error: "INVALID_REQUEST" };
}

/**
 * 1 施設・1 か月ぶんの入力品質（§6.3）。
 *
 * **施設を必須にする。** 組織全体の入力率は「どの施設を直せばよいか」を
 * 隠す（§6.3 の画面も施設 1 つぶん）。
 */
dataQuality.get("/", async (c) => {
  const ctx = getTenant(c);
  const propertyId = c.req.query("propertyId");
  const month = c.req.query("month");
  if (propertyId === undefined || month === undefined) return c.json(invalidRequest(), 400);

  const parsedMonth = dataQualityMonthSchema.safeParse(month);
  if (!parsedMonth.success) return c.json(invalidRequest(), 400);
  const range = monthRangeOf(parsedMonth.data);
  if (range === null) return c.json(invalidRequest(), 400);

  assertPermission(ctx, "dataQuality.read", propertyTarget([propertyId]));

  const property = await findPropertyById(c.env, ctx, propertyId);
  if (property === undefined) return c.notFound();

  const body: DataQualityResponse = await collectDataQuality(c.env, ctx, {
    propertyId,
    month: parsedMonth.data,
    range,
  });
  return c.json(body);
});

export default dataQuality;
