/**
 * 施設ごとの検査方式（`propertyInspectionPolicy`）のリポジトリ。
 *
 * task: docs/tasks/P2-02.md
 * 仕様: docs/PK-SPEC-P2.md §2.1
 *
 * ── 行が無いことに意味がある ────────────────────────────
 * 未設定の施設では行を作らない。**読み取りのついでに既定行を挿入しない。**
 * 挿入すると、設定を触っていない施設が「検査方式を設定済み」に見える。
 *
 * ── 移行を通した（P2-16 / §13.2）────────────────────────
 * `0011_p2_16_inspection_policy_backfill.sql` が、既存の全施設に対して
 * `property.inspectionRequired` から行を作った。以後は**施設を作るときに
 * 行も作る**（`createProperty()`）。行が無い施設はもう生まれない。
 * それでも読み取り側の `policyFromLegacyFlag()` を残してあるのは、
 * **移行が届いていないシャードで既定（`ALL`）へ落ちないため**
 * （落ちると全タスクが検査待ちで滞留する / OPEN_QUESTIONS #044）。
 * 旧列と一緒に消すのは次リリース（architecture.md §6 の③）。
 */

import { eq } from "drizzle-orm";

import type { Env } from "../env.js";
import { assertIdBelongsToTenant, generateId } from "../id.js";
import { getTenantDb, type TenantContext } from "../router.js";
import { propertyInspectionPolicy, type InspectionMode } from "../schema/inspection.js";

import { withTenantScope } from "./base.js";

/**
 * P1 の真偽値 1 つから作る検査方式（PK-SPEC-P2 §13.2 の CASE 式）。
 *
 * **`packages/engine` の `policyFromLegacyFlag()` と同じ値を返す。**
 * `@pk/db` は `@pk/engine` に依存しない（engine は依存ゼロの純粋関数群で、
 * 向きを逆にすると DB 側の型が engine へ流れ込む）ので、写しを 1 つ持つ。
 * **3 か所を揃えて変えること**（ここ / engine / 0011 のマイグレーション）。
 *
 * `minDailySample` を 0 にしてあるのは engine 側と同じ理由で、`ALL` / `NONE`
 * では効かない値だから。設定画面（W-02）が `SAMPLE` を選んだときに初めて
 * 意味を持つ。
 */
export function legacyPolicyValues(inspectionRequired: boolean): InspectionPolicyInput {
  return {
    mode: inspectionRequired ? "ALL" : "NONE",
    sampleRate: inspectionRequired ? 100 : 0,
    minDailySample: 0,
    alwaysInspectCheckin: true,
    alwaysInspectRework: true,
    selfInspectionAllowed: false,
    autoAssignInspector: true,
    inspectionSlaMinutes: 20,
  };
}

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
