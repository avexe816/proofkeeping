/**
 * 標準時間マスタのリポジトリ（W-17）。
 *
 * task: docs/tasks/P1-02.md
 * 仕様: docs/PK-SPEC-P1.md §3.1（既定分数より優先）/ §10.1
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { standardTime, type TaskType } from "../schema/task.js";

import { withTenantScope } from "./base.js";

/** 施設 1 件ぶんの標準時間。 */
export async function listStandardTimes(env: Env, ctx: TenantContext, propertyId: string) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(standardTime)
    .where(
      withTenantScope(
        standardTime,
        ctx,
        standardTime.propertyId,
        eq(standardTime.propertyId, propertyId),
      ),
    );
}

/** 設定する 1 件。 */
export interface StandardTimeInput {
  roomTypeId: string;
  taskType: TaskType;
  minutes: number;
}

/**
 * 施設の標準時間をまとめて設定する。
 *
 * 冪等: 一意制約 `(organizationId, propertyId, roomTypeId, taskType)` に対する
 * upsert。**同じ入力を 3 回送っても行が増えない。**
 *
 * **設定に無い組み合わせを消さない。** 画面が一部だけ送ってきたときに、
 * 送られなかった行が消えると、別の担当者の設定が黙って失われる。
 * 消す操作は別に用意する（P1-02 の範囲では要らない）。
 */
export async function upsertStandardTimes(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  inputs: readonly StandardTimeInput[],
): Promise<number> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  let applied = 0;
  for (const input of inputs) {
    await db
      .insert(standardTime)
      .values({
        id: generateId(ctx.orgShortId, "stdt"),
        organizationId: ctx.organizationId,
        propertyId,
        roomTypeId: input.roomTypeId,
        taskType: input.taskType,
        minutes: input.minutes,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .onConflictDoUpdate({
        target: [
          standardTime.organizationId,
          standardTime.propertyId,
          standardTime.roomTypeId,
          standardTime.taskType,
        ],
        set: { minutes: input.minutes, updatedAt: ctx.now },
      });
    applied += 1;
  }
  return applied;
}
