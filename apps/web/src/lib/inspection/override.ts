/**
 * 残存タスクの緊急上書き（PK-SPEC-P2 §13.3）。
 *
 * task: docs/tasks/P2-16.md
 *
 * ── これは移行の後始末であって、業務の操作ではない ──────
 * §13.3 は「P2 リリース前に `AWAITING_INSPECTION` のタスクは施設責任者が
 * 処理してから移行する。**残存がある場合は `EMERGENCY_OVERRIDE` として
 * 完了させ、監査ログに記録する**」と定める。ここはその「残存がある場合」。
 *
 * ── §13.1 で消した一括承認との違い ──────────────────────
 * どちらも「検査せずに客室を `READY` にする」。違いは 3 つで、**どれも
 * 落とさないこと。** 落とすと一括承認がそのまま戻る。
 *   ① 1 件ずつ … 配列も「施設ぶん全部」も受け取らない
 *   ② 理由必須 … `reason` の無い呼び出しを 400 で落とす
 *   ③ 監査ログ … `inspection.emergencyOverride`（`requiresReason: true`）
 * 権限も分けてある（`inspection.emergencyOverride` / 施設責任者以上）。
 *
 * ── 「検査なし」を「検査合格」にしない（§2.3）────────────
 * `inspectionResult` を書かない。書くのは `inspectionSkipped = true` と
 * `inspectionSkipReason = EMERGENCY_OVERRIDE` だけ。§10.1 の初回検査合格率も
 * §9 の日報も**検査の記録があるタスク**を分母に取るので、上書きした分は
 * 検査の母数に入らない（入れると合格率が実態より良く見える）。
 *
 * ── 検査中のタスクは横取りしない ────────────────────────
 * 開いている検査があるなら断る。検査者が入力の途中で、その検査は
 * `AWAITING_INSPECTION` のまま完了を待っている。上書きすると、
 * 二度と閉じられない検査行が残る。
 */

import type { InspectionError, InspectionOverrideResponse } from "@pk/contracts";
import {
  applyTransition,
  findOpenInspectionByTask,
  findTaskById,
  NotFoundError,
  recordAudit,
  setHousekeepingStatus,
  type Env,
  type TenantContext,
} from "@pk/db";
import { housekeepingStatusFor } from "@pk/engine";

import { assertPermission, propertyTarget } from "../auth/permission.js";

/** 緊急上書きの入力。**`propertyId` を受け取らない**（資源から解決する / INV-32）。 */
export interface OverrideInspectionInput {
  taskId: string;
  /** 操作者の `membership.id`。 */
  actorId: string;
  /** 理由。**必須**（§13.3 / `AUDIT_ACTIONS` の `requiresReason`）。 */
  reason: string;
  ip?: string | undefined;
}

export type OverrideInspectionOutcome =
  | { kind: "OK"; body: InspectionOverrideResponse }
  | { kind: "REJECTED"; error: InspectionError["error"] };

/**
 * 検査待ちのタスクを、検査せずに完了させる。
 *
 * @throws {NotFoundError} タスクが無い・別テナント・権限が無い（すべて 404 / INV-31）。
 */
export async function overrideInspection(
  env: Env,
  ctx: TenantContext,
  input: OverrideInspectionInput,
): Promise<OverrideInspectionOutcome> {
  const task = await findTaskById(env, ctx, input.taskId);
  if (task === undefined) throw new NotFoundError();

  // **施設はタスクから解決した値で判定する**（INV-32）。
  assertPermission(ctx, "inspection.emergencyOverride", propertyTarget([task.propertyId]));

  // 再送。**既に上書き済みなら成功として返す。** 状態は動かさない。
  if (task.status === "COMPLETED" && task.inspectionSkipReason === "EMERGENCY_OVERRIDE") {
    return { kind: "OK", body: { taskId: task.id, status: "COMPLETED", unchanged: true } };
  }
  if (task.status !== "AWAITING_INSPECTION") {
    return { kind: "REJECTED", error: "INVALID_TRANSITION" };
  }

  // 冒頭の注記。**検査中のタスクは横取りしない。**
  const open = await findOpenInspectionByTask(env, ctx, task.id);
  if (open !== undefined) {
    return { kind: "REJECTED", error: "INSPECTION_ALREADY_STARTED" };
  }

  const moved = await applyTransition(env, ctx, task.id, "AWAITING_INSPECTION", {
    status: "COMPLETED",
    // 要否と省略理由は一組で書く（`ApplyTransitionInput` の注記）。
    // **`required` は `true` のまま。** 検査は要るはずだったが行われなかった、
    // が起きたこと。`false` にすると「そもそも検査対象でなかった」に化ける。
    inspection: { required: true, skipped: true, skipReason: "EMERGENCY_OVERRIDE" },
  });
  if (!moved) {
    // 判定してから更新するまでの間に別の操作が着地した（楽観的排他）。
    // 検査が始まった・検査が終わった、のどちらか。**やり直させる。**
    return { kind: "REJECTED", error: "INVALID_TRANSITION" };
  }

  // 客室（§11.1）。`INSPECTING` のまま残すと、二度と検査されない客室が
  // 客室ボードで作業中に見え続ける。
  const roomStatus = housekeepingStatusFor("emergencyOverride", true);
  if (roomStatus !== null) {
    await setHousekeepingStatus(env, ctx, [task.roomId], roomStatus);
  }

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "inspection.emergencyOverride",
    targetType: "cleaningTask",
    targetId: task.id,
    propertyId: task.propertyId,
    before: { status: "AWAITING_INSPECTION" },
    after: { status: "COMPLETED", inspectionSkipReason: "EMERGENCY_OVERRIDE" },
    reason: input.reason,
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  return { kind: "OK", body: { taskId: task.id, status: "COMPLETED", unchanged: false } };
}
