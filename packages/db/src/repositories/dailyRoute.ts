/**
 * 当日の施設訪問順のリポジトリ（PK-SPEC-P1 §19.5）。
 *
 * task: docs/tasks/P1-21.md
 *
 * ── 読み取りだけ ────────────────────────────────────────
 * P1 に入力画面が無い（シフト管理は P8 Workforce）。**書き込み関数を
 * 「あとで要るから」で足さないこと**（CLAUDE.md §1-4）。
 *
 * ── 施設スコープを掛けない ──────────────────────────────
 * `withTenantScope()` の第 3 引数（施設列）に `null` を渡す。
 * この表は**担当者の 1 日の動線**で、行は「担当者 × 業務日 × 順番」。
 * 施設スコープで絞ると、担当を外された施設の行が消えて訪問順に穴が空き、
 * **移動ブロックが 1 つ飛ばしで描かれる。** 行そのものは
 * `membershipId` で必ず絞るので、他人の動線は返らない。
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { dailyRoute } from "../schema/task.js";

import { NO_PROPERTY_SCOPE, withTenantScope } from "./base.js";

/**
 * 1 人 × 1 業務日の訪問順。**`sequence` 昇順。**
 *
 * 登録が無ければ空配列。呼び出し側は**空でも動くこと**（§19.5 MUST）。
 *
 * @param membershipId 担当者。**セッションから解決した値を渡すこと。**
 *   クライアントの入力を通すと、他人の動線が読める口になる（INV-07）。
 */
export async function listDailyRoute(
  env: Env,
  ctx: TenantContext,
  membershipId: string,
  businessDate: string,
) {
  assertIdBelongsToTenant(membershipId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(dailyRoute)
    .where(
      withTenantScope(
        dailyRoute,
        ctx,
        NO_PROPERTY_SCOPE,
        eq(dailyRoute.membershipId, membershipId),
        eq(dailyRoute.businessDate, businessDate),
      ),
    )
    .orderBy(dailyRoute.sequence);
}
