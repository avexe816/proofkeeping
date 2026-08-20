/**
 * 期限切れによる配分停止（P8-02 / PK-SPEC-P8 §1.4 MUST）。
 *
 * task:  docs/tasks/P8-02.md
 *
 * > 期限切れ時、そのスタッフへの新規タスク配分を自動停止する。
 * > 既存の未完了タスクは残す（現場を止めないため）。
 *
 * ── 「新規配分」だけを止める ────────────────────────────
 * 止めるのは W-04 の配分（自動・手動とも）。**既に割り当たっている
 * タスクは外さない**し、本人がタスクを開始することも妨げない。
 * 仕様が止めろと言っているのは配分であって就業ではない —
 * 就労可否の判断は事業者が行う（§1.4 MUST）。
 *
 * ── 解除はここに無い ────────────────────────────────────
 * `ORG_ADMIN` が `expiresOn` を更新すれば、次の読み取りから
 * 自然に集合から消える。**解除の関数・フラグを作らない**（§1.4 MUST
 * 「手動での解除ボタンを作らない」）。
 */

import { listExpiredResidencyStaffIds, listStaffLedger, type Env, type TenantContext } from "@pk/db";

/**
 * 新規配分を止める `membershipId` の集合。
 *
 * 期限切れ（`expiresOn < businessDate`）の在留資格を持つスタッフを、
 * 台帳経由で `membershipId` に写す。台帳から消えた行の残骸は無視する。
 *
 * **空のときに台帳を読まない。** ほとんどの組織で期限切れは 0 件なので、
 * 余計な往復を足さない。
 */
export async function listAssignmentBlockedMembershipIds(
  env: Env,
  ctx: TenantContext,
  businessDate: string,
): Promise<ReadonlySet<string>> {
  const staffProfileIds = await listExpiredResidencyStaffIds(env, ctx, businessDate);
  if (staffProfileIds.length === 0) return new Set();

  const ledger = await listStaffLedger(env, ctx);
  const membershipById = new Map(ledger.map((row) => [row.id, row.membershipId]));

  const blocked = new Set<string>();
  for (const staffProfileId of staffProfileIds) {
    const membershipId = membershipById.get(staffProfileId);
    if (membershipId !== undefined) blocked.add(membershipId);
  }
  return blocked;
}
