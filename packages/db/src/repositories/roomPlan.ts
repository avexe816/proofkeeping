/**
 * 当日の客室状況（`dailyRoomPlan`）のリポジトリ（W-05）。
 *
 * task: docs/tasks/P1-04.md
 * 仕様: docs/PK-SPEC-P1.md §2.1 / §3.4 / §10.3
 *
 * ── 保存しない情報 ──────────────────────────────────────
 * 宿泊者の氏名・連絡先・予約者情報を受け取る関数を作らない
 * （security.md §3 / INV。**人数だけで足りる**）。
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { dailyRoomPlan, type RoomPlanSource } from "../schema/task.js";

import { withTenantScope } from "./base.js";

/** 施設 × 業務日の入力状況。 */
export async function listRoomPlans(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(dailyRoomPlan)
    .where(
      withTenantScope(
        dailyRoomPlan,
        ctx,
        dailyRoomPlan.propertyId,
        eq(dailyRoomPlan.propertyId, propertyId),
        eq(dailyRoomPlan.businessDate, businessDate),
      ),
    );
}

/** 1 客室ぶんの入力。 */
export interface RoomPlanInput {
  roomId: string;
  hasCheckout: boolean;
  hasCheckin: boolean;
  isStayover: boolean;
  guestCount: number;
  declineClean: boolean;
}

/**
 * 客室状況をまとめて登録・更新する。
 *
 * 冪等: 一意制約 `(organizationId, roomId, businessDate)` に対する upsert。
 * **CSV を 3 回取り込んでも行が増えない**（testing.md §4）。
 *
 * `source` は入力経路（`MANUAL` / `CSV`）。**上書きの可否を経路で変えない。**
 * 手入力を CSV が上書きできないようにすると、間違えた行を直す手段が
 * 現場から消える（§3.4 の「逃げ道を必ず用意する」と同じ趣旨）。
 */
export async function upsertRoomPlans(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
  inputs: readonly RoomPlanInput[],
  source: RoomPlanSource,
): Promise<number> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  let applied = 0;
  for (const input of inputs) {
    await db
      .insert(dailyRoomPlan)
      .values({
        id: generateId(ctx.orgShortId, "plan"),
        organizationId: ctx.organizationId,
        propertyId,
        roomId: input.roomId,
        businessDate,
        hasCheckout: input.hasCheckout,
        hasCheckin: input.hasCheckin,
        isStayover: input.isStayover,
        guestCount: input.guestCount,
        declineClean: input.declineClean,
        source,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [dailyRoomPlan.organizationId, dailyRoomPlan.roomId, dailyRoomPlan.businessDate],
        set: {
          hasCheckout: input.hasCheckout,
          hasCheckin: input.hasCheckin,
          isStayover: input.isStayover,
          guestCount: input.guestCount,
          declineClean: input.declineClean,
          source,
          updatedAt: ctx.now,
        },
      });
    applied += 1;
  }
  return applied;
}
