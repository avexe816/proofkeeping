/**
 * 日次集計のリポジトリ。
 *
 * task: docs/tasks/P0-21.md
 * 仕様: docs/PK-SPEC-P0.md §19.6, §23.3
 *
 * **施設サマリーはこの表からのみ取る**（§26 の絶対ルール）。
 * タスクテーブルへ直接集計する関数をここへ足さないこと。
 *
 * 書き込み（再計算 UPSERT）は Queue コンシューマの担当で、P1 以降。
 * P0 は読みだけを置く。
 */

import { and, eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { dailyPropertyRollup } from "../schema/rollup.js";

import { withTenantScope } from "./base.js";

/**
 * その業務日の集計を、到達できる施設ぶんだけ返す。
 *
 * 施設スコープロールには担当施設の行だけが返る（第 1 層）。
 * **行が無い施設は返らない。** 呼び出し側が「まだ集計が無い」として扱う。
 */
export async function listPropertyRollups(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(dailyPropertyRollup)
    .where(
      withTenantScope(
        dailyPropertyRollup,
        ctx,
        dailyPropertyRollup.propertyId,
        eq(dailyPropertyRollup.businessDate, businessDate),
      ),
    );
}

/**
 * 施設 1 件の集計。
 *
 * 別組織の施設 ID は DB へ行く前に `NotFoundError`（第 2 層）。
 * **「集計がまだ無い」は別の話**で、そちらは自組織の ID に対して
 * `undefined` が返る。例外にしない。
 */
export async function findPropertyRollup(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const rows = await db
    .select()
    .from(dailyPropertyRollup)
    .where(
      withTenantScope(
        dailyPropertyRollup,
        ctx,
        dailyPropertyRollup.propertyId,
        and(
          eq(dailyPropertyRollup.propertyId, propertyId),
          eq(dailyPropertyRollup.businessDate, businessDate),
        ),
      ),
    )
    .limit(1);
  return rows[0];
}
