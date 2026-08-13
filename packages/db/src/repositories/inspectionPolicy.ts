/**
 * 施設ごとの検査方式（`propertyInspectionPolicy`）のリポジトリ。
 *
 * task: docs/tasks/P2-02.md
 * 仕様: docs/PK-SPEC-P2.md §2.1
 *
 * ── 行が無いことに意味がある ────────────────────────────
 * 未設定の施設では行を作らない。呼び出し側は P1 の
 * `property.inspectionRequired` から `policyFromLegacyFlag()` で組み立てる
 * （`packages/engine`）。**読み取りのついでに既定行を挿入しないこと。**
 * 挿入すると、P1 の設定を触っていない施設が「検査方式を設定済み」に見え、
 * 移行（P2-16）でどちらが正か分からなくなる。
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { propertyInspectionPolicy, type InspectionMode } from "../schema/inspection.js";

import { withTenantScope } from "./base.js";

/** 施設の検査方式。**未設定なら `undefined`。** */
export async function findInspectionPolicy(env: Env, ctx: TenantContext, propertyId: string) {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);
  const [row] = await db
    .select()
    .from(propertyInspectionPolicy)
    .where(
      withTenantScope(
        propertyInspectionPolicy,
        ctx,
        propertyInspectionPolicy.propertyId,
        eq(propertyInspectionPolicy.propertyId, propertyId),
      ),
    )
    .limit(1);
  return row;
}

/** 施設の一覧（W-02 の設定画面が使う）。 */
export async function listInspectionPolicies(env: Env, ctx: TenantContext) {
  const db = await getTenantDb(env, ctx);
  return db
    .select()
    .from(propertyInspectionPolicy)
    .where(
      withTenantScope(propertyInspectionPolicy, ctx, propertyInspectionPolicy.propertyId),
    );
}

/** 設定できる値（§2.1）。 */
export interface InspectionPolicyInput {
  mode: InspectionMode;
  sampleRate: number;
  minDailySample: number;
  alwaysInspectCheckin: boolean;
  alwaysInspectRework: boolean;
  selfInspectionAllowed: boolean;
  autoAssignInspector: boolean;
  inspectionSlaMinutes: number;
}

/**
 * 施設の検査方式を登録・更新する。
 *
 * 冪等: 一意制約 `(organizationId, propertyId)` に対する upsert。
 * **設定変更そのものは監査ログの対象**（security.md §6「施設マスタの更新」）。
 * `recordAudit()` は呼び出し側（API ハンドラ）が呼ぶ。
 */
export async function upsertInspectionPolicy(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  input: InspectionPolicyInput,
): Promise<void> {
  assertIdBelongsToTenant(propertyId, ctx);
  const db = await getTenantDb(env, ctx);

  await db
    .insert(propertyInspectionPolicy)
    .values({
      id: generateId(ctx.orgShortId, "ipol"),
      organizationId: ctx.organizationId,
      propertyId,
      ...input,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [propertyInspectionPolicy.organizationId, propertyInspectionPolicy.propertyId],
      set: { ...input, updatedAt: ctx.now },
    });
}
