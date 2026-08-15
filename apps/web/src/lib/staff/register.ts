/**
 * 現場スタッフの登録（PK-SPEC-P7 §2.3 Step 5）。
 *
 * task:  docs/tasks/P7-02.md（P7-01 の `routes/api/v1/users.ts` から切り出し）
 * ルール: .claude/rules/security.md §1 / §2 / §6
 * 決定:  docs/DECISIONS.md #177（PIN はサーバーが発行し 1 回だけ返す）/ #181
 *
 * ── なぜ切り出したのか ──────────────────────────────────
 * P7-01 は API（`POST /api/v1/users`）だけを置き、画面を持たなかった
 * （OPEN_QUESTIONS #103）。P7-02 で登録画面を作るにあたり、**同じ操作の
 * 実装が API と画面の 2 つになる**のを避けた（DECISIONS #181 と同じ考え）。
 * 権限判定・PIN の発行・監査ログはここ 1 か所にある。
 *
 * ── PIN はここでしか作られず、ここでしか返らない ────────
 * 保存するのはハッシュだけで、後から引き出す経路が無い（API キーと同じ
 * 扱い / security.md §7）。**戻り値を保存し直さないこと。** 呼び出し側は
 * 応答（API）か `action` の戻り値（画面）として 1 回出すだけにする。
 * **`loader` へ渡さない。** `loader` は GET で、URL にも履歴にも残る。
 */

import type { FieldStaffCreateRequest, FieldStaffCreateResponse } from "@pk/contracts";
import { createFieldStaff, recordAudit, type Env, type TenantContext } from "@pk/db";

import { assertPermission, propertyTarget } from "../auth/permission.js";
import { generateInitialPin, hashPin } from "../auth/pin.js";

/**
 * 登録の結果。
 *
 * **スタッフ番号が重複したときに既存の行を返さない。** 返すと別人へ
 * 他人の案内カードを配ることになる（`users.ts` の 409 と同じ判断）。
 */
export type RegisterFieldStaffOutcome =
  | { readonly created: true; readonly staff: FieldStaffCreateResponse }
  | { readonly created: false };

/**
 * 現場スタッフを 1 名登録し、**初期 PIN を 1 回だけ返す。**
 *
 * 権限は**登録しようとしている施設**を対象に見る。`PROPERTY_MANAGER` は
 * `ASSIGNED` なので、担当外の施設へスタッフを差し込めない。
 * `propertyIds` はリクエスト由来の値だが、`assertPermission()` と
 * 第 2 層（`createFieldStaff()` 内の `assertIdBelongsToTenant()`）の
 * 両方を通る。
 *
 * @param actorId 操作者の membership ID。監査で辿れるようにする。
 */
export async function registerFieldStaff(
  env: Env,
  ctx: TenantContext,
  input: FieldStaffCreateRequest,
  actorId: string,
): Promise<RegisterFieldStaffOutcome> {
  assertPermission(ctx, "user.write", propertyTarget(input.propertyIds));

  const pin = generateInitialPin();
  const result = await createFieldStaff(env, ctx, {
    displayName: input.displayName,
    staffNumber: input.staffNumber,
    role: input.role,
    email: input.email ?? null,
    pinHash: await hashPin(pin),
    locale: input.locale,
    propertyIds: input.propertyIds,
    invitedBy: actorId,
  });

  if (!result.created) return { created: false };

  await recordAudit(env, ctx, {
    actorId,
    action: "user.invited",
    targetType: "user",
    targetId: result.userId,
    // **`after` に PIN もハッシュも載せない**（security.md §6）。
    after: {
      staffNumber: input.staffNumber,
      displayName: input.displayName,
      role: input.role,
      propertyIds: input.propertyIds,
    },
  });

  return {
    created: true,
    staff: {
      userId: result.userId,
      membershipId: result.membershipId,
      staffNumber: input.staffNumber,
      displayName: input.displayName,
      role: input.role,
      propertyIds: [...input.propertyIds],
      initialPin: pin,
    },
  };
}
