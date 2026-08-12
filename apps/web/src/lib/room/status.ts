/**
 * 客室ステータスの手動上書き（PK-SPEC-P1 §11.2）。
 *
 * task:  docs/tasks/P1-16.md
 * ルール: .claude/rules/security.md §6
 *
 * ── 3 つとも欠けてはいけない ────────────────────────────
 *   1. 権限（施設は**客室から解決する** / INV-32）
 *   2. 理由の必須（空文字を通さない）
 *   3. `AuditLog` に `room.statusOverridden` として残す
 *
 * **この記録は P4 の検出ルール R010（手動上書きの頻発）が使う**（§11.2）。
 * P1 の時点で確実に残しておかないと、P4 で「いつから増えたのか」が
 * 分からなくなる。監査ログは後から作り直せない。
 *
 * ── 画面が 2 つあるので関数を 1 つにする ────────────────
 * W-03（PC）と M-10（モバイル）の両方から上書きできる。それぞれの
 * `action` に同じ手順を書くと、片方だけ理由必須が外れる事故が起きる。
 */

import {
  findRoomById,
  NotFoundError,
  recordAudit,
  setHousekeepingStatus,
  type Env,
  type HousekeepingStatus,
  type TenantContext,
} from "@pk/db";

import { assertPermission, propertyTarget } from "../auth/permission.js";

/** 上書きの入力。**`propertyId` を受け取らない**（客室から解決する）。 */
export interface OverrideRoomStatusInput {
  roomId: string;
  status: HousekeepingStatus;
  /** 理由。**必須**（§11.2）。空文字・空白のみは拒否する。 */
  reason: string;
  /** 操作者の `membership.id`。 */
  actorId: string;
  ip?: string | undefined;
}

/** 上書きの結果。**文言を持たない**（画面が i18n キーへ写す）。 */
export type OverrideRoomStatusOutcome =
  | { kind: "OK"; before: HousekeepingStatus; after: HousekeepingStatus }
  | { kind: "REJECTED"; error: "REASON_REQUIRED" };

/**
 * 客室ステータスを手動で書き換える。
 *
 * @throws {NotFoundError} 客室が無い・別テナント・権限が無い（すべて 404 / INV-31）。
 */
export async function overrideRoomStatus(
  env: Env,
  ctx: TenantContext,
  input: OverrideRoomStatusInput,
): Promise<OverrideRoomStatusOutcome> {
  const room = await findRoomById(env, ctx, input.roomId);
  if (room === undefined) throw new NotFoundError();

  // 施設は**客室から解決した値**を使う（INV-32）。
  assertPermission(ctx, "room.statusOverride", propertyTarget([room.propertyId]));

  const reason = input.reason.trim();
  // 理由の無い上書きは記録として価値がない（`recordAudit()` も同じ判断で
  // 落とすが、DB を書いたあとに投げると客室だけ変わった状態が残る）。
  if (reason === "") return { kind: "REJECTED", error: "REASON_REQUIRED" };

  const before = room.housekeepingStatus;
  if (before === input.status) {
    // 同じ値。**書かず、監査ログも残さない。** 押し直しで履歴が膨らむと、
    // R010（手動上書きの頻発）が押し間違いを拾う。
    return { kind: "OK", before, after: before };
  }

  await setHousekeepingStatus(env, ctx, [input.roomId], input.status);

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "room.statusOverridden",
    targetType: "room",
    targetId: input.roomId,
    propertyId: room.propertyId,
    before: { housekeepingStatus: before },
    after: { housekeepingStatus: input.status },
    reason,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return { kind: "OK", before, after: input.status };
}
