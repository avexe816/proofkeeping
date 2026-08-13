/**
 * 再清掃の開始・完了・免除（PK-SPEC-P2 §4.6 / §4.7）。
 *
 * task:  docs/tasks/P2-07.md
 * ルール: .claude/rules/security.md §1 / §6
 *
 * ── 呼ぶ順序 ────────────────────────────────────────────
 *   1. 差戻しを引く → タスクを引く（施設は**資源から解決する** / INV-32）
 *   2. `assertPermission()` → `assertReworkVisible()`（自分の差戻しか）
 *   3. 差戻しの状態機械（`packages/engine`）で可否を見る
 *   4. **タスク側を先に動かす**（`runTransition()`）
 *   5. 差戻しサイクルを 1 段進める（`status = from` の行にだけ当たる）
 *   6. 完了なら `REWORK_COMPLETION` の証跡 → 監査ログ
 *
 * **4 を 5 より前に置くこと。** 逆にすると、タスク側が拒否される操作で
 * 差戻しだけが進む。この順序なら、途中で落ちても再送で続きから進む
 * （タスクの遷移は再送で `NOOP`、差戻しは `status = from` で 1 回だけ）。
 *
 * ── 免除はタスクを進めない ──────────────────────────────
 * §4.7 は「免除後に客室を READY にするか BLOCKED にするか選択させる」だけで、
 * タスクの状態には触れていない。**タスクは `REWORK` のまま残す。**
 * 免除は「この差戻しを追わない」という判断で、清掃が終わったことでは
 * ないため、`COMPLETED` へ動かすと §10.1 の合格率が実態と合わなくなる。
 * 動くのは客室ステータスだけ（`room.statusOverridden` として監査に残す）。
 */

import type { ReworkActionResponse, ReworkErrorCode, WaiveRoomOutcomeValue } from "@pk/contracts";
import {
  advanceReworkCycle,
  findReworkCycleById,
  findRoomById,
  findTaskById,
  NotFoundError,
  recordAudit,
  setHousekeepingStatus,
  type Env,
  type TenantContext,
} from "@pk/db";
import { checkWaiveRequirements, evaluateReworkTransition, type ReworkAction } from "@pk/engine";

import { assertPermission, propertyTarget } from "../auth/permission.js";
import { buildReworkCompletionEvidence } from "../evidence/payload.js";
import { recordEvidence } from "../evidence/record.js";
import { runTransition } from "../task/transition.js";

import { assertReworkVisible, toRework } from "./detail.js";

/** 免除の入力（§4.7。**3 つとも必須**）。 */
export interface WaiveInput {
  reason: string;
  issueReportId: string;
  roomOutcome: WaiveRoomOutcomeValue;
}

/** 操作の入力。**`status` を受け取らない**（状態機械が決める）。 */
export interface AdvanceReworkInput {
  reworkCycleId: string;
  action: ReworkAction;
  /** 操作者の `membership.id`。 */
  actorId: string;
  /** `waive` のときだけ。 */
  waive?: WaiveInput | undefined;
  clientTs?: number | undefined;
  idempotencyKey?: string | undefined;
  ip?: string | undefined;
}

/** 操作の結果。 */
export type AdvanceReworkOutcome =
  | { kind: "OK"; body: ReworkActionResponse }
  | { kind: "REJECTED"; error: ReworkErrorCode };

/** その操作が要求する権限。§4.7 の免除だけ別（`PROPERTY_MANAGER` 以上）。 */
function permissionFor(action: ReworkAction): "rework.write" | "rework.waive" {
  return action === "waive" ? "rework.waive" : "rework.write";
}

/**
 * 差戻しを 1 段進める。
 *
 * @throws {NotFoundError} 差戻しが無い・別テナント・権限が無い・自分の
 *   差戻しでない（すべて 404 / INV-31）。
 */
export async function advanceReworkUseCase(
  env: Env,
  ctx: TenantContext,
  input: AdvanceReworkInput,
): Promise<AdvanceReworkOutcome> {
  const row = await findReworkCycleById(env, ctx, input.reworkCycleId);
  if (row === undefined) throw new NotFoundError();

  const task = await findTaskById(env, ctx, row.taskId);
  if (task === undefined) throw new NotFoundError();
  assertPermission(ctx, permissionFor(input.action), propertyTarget([task.propertyId]));
  // **`CLEANER` は自分の差戻しだけ**（§4.6）。
  assertReworkVisible(ctx, row, input.actorId);

  const room = await findRoomById(env, ctx, task.roomId);
  const taskInfo = {
    businessDate: task.businessDate,
    roomNumber: room?.roomNumber ?? "",
  };

  // ── 免除の必須項目（§4.7）。**状態機械より前に見る。** ──────
  // 順序を逆にすると、理由が無い免除で差戻しの状態だけが動く。
  if (input.action === "waive") {
    const check = checkWaiveRequirements(
      input.waive?.reason ?? null,
      input.waive?.issueReportId ?? null,
    );
    if (!check.ok) {
      return {
        kind: "REJECTED",
        error: check.missingReason ? "REASON_REQUIRED" : "ISSUE_REPORT_REQUIRED",
      };
    }
  }

  const decision = evaluateReworkTransition(row.status, input.action);
  if (decision.kind === "REJECTED") {
    // **決着済みと「その状態からできない」を区別する。** 画面の文言が違う
    // （前者は「もう片付いています」、後者は「先に開始してください」）。
    return {
      kind: "REJECTED",
      error:
        row.status === "RESOLVED" || row.status === "WAIVED"
          ? "REWORK_ALREADY_SETTLED"
          : "INVALID_TRANSITION",
    };
  }
  if (decision.kind === "NOOP") {
    // 再送。**状態を変えず、いまの姿を返す。** オフラインキューは
    // これを成功として扱ってキューから消す（ui-writing.md §5）。
    return {
      kind: "OK",
      body: { data: toRework(row, taskInfo), taskStatus: task.status, unchanged: true },
    };
  }

  // ── タスク側（§4.1 の状態遷移）───────────────────────────
  // **免除はタスクに触らない**（冒頭の注記）。
  let taskStatus = task.status;
  if (input.action !== "waive") {
    const moved = await runTransition(env, ctx, {
      taskId: task.id,
      action: input.action === "start" ? "start" : "complete",
      actorId: input.actorId,
      ...(input.clientTs === undefined ? {} : { clientTs: input.clientTs }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
    if (moved.kind === "REJECTED") {
      // チェックリストの未完了・写真不足も含めてここへ来る。
      // **差戻しの状態は動かさない。**
      return { kind: "REJECTED", error: "TASK_INVALID_TRANSITION" };
    }
    taskStatus = moved.status;
  }

  // ── 差戻しサイクル ──────────────────────────────────────
  const advanced = await advanceReworkCycle(env, ctx, row.id, {
    from: row.status,
    to: decision.to,
    ...(input.action === "start" ? { startedAt: ctx.now } : {}),
    ...(input.action === "complete" ? { completedAt: ctx.now } : {}),
    ...(input.action === "waive"
      ? {
          waivedById: input.actorId,
          waivedReason: input.waive?.reason ?? null,
          waivedIssueId: input.waive?.issueReportId ?? null,
        }
      : {}),
  });
  if (!advanced) {
    // 判定してから進めるまでの間に別の操作が着地した（楽観的排他）。
    // **やり直さない。** タスク側は既に動いているが、それは再送でも同じ結果。
    const latest = await findReworkCycleById(env, ctx, row.id);
    return {
      kind: "OK",
      body: { data: toRework(latest ?? row, taskInfo), taskStatus, unchanged: true },
    };
  }

  // ── 免除後の客室（§4.7）────────────────────────────────
  // **READY / BLOCKED を選ばせた結果をそのまま反映する。** 既定を持たない。
  if (input.action === "waive" && input.waive !== undefined) {
    await setHousekeepingStatus(
      env,
      ctx,
      [task.roomId],
      input.waive.roomOutcome === "READY" ? "READY" : "BLOCKED",
    );
  }

  // ── 証跡（§6.2 / P2-08）─────────────────────────────────
  // **再清掃の完了だけ。** 開始と免除は `EvidenceType` に無い（§3.7）。
  if (input.action === "complete") {
    await recordEvidence(env, ctx, {
      propertyId: task.propertyId,
      taskId: task.id,
      businessDate: task.businessDate,
      evidenceType: "REWORK_COMPLETION",
      payload: () =>
        buildReworkCompletionEvidence(
          env,
          ctx,
          { taskId: task.id, roomId: task.roomId, businessDate: task.businessDate },
          {
            reworkCycleId: row.id,
            inspectionId: row.inspectionId,
            round: row.round,
            assignedToId: row.assignedToId,
            reasonSummary: row.reasonSummary,
            startedAtMs: row.startedAt?.getTime() ?? null,
            completedAtMs: ctx.now.getTime(),
          },
        ),
      createdById: input.actorId,
    });
  }

  await recordAdvanceAudit(env, ctx, input, {
    propertyId: task.propertyId,
    taskId: task.id,
    round: row.round,
  });

  const latest = await findReworkCycleById(env, ctx, row.id);
  return {
    kind: "OK",
    body: { data: toRework(latest ?? row, taskInfo), taskStatus, unchanged: false },
  };
}

/**
 * 監査ログ（security.md §6「タスクの完了・検査合格・差戻し」/ §4.7）。
 *
 * **開始を記録しない。** 清掃員の操作履歴を記録の目的以外に使えてしまう
 * （INV-07 / `lib/task/transition.ts` が `start` を記録しないのと同じ）。
 * 開始時刻は `reworkCycle.startedAt` に残り、本人は M-11 で見られる。
 */
async function recordAdvanceAudit(
  env: Env,
  ctx: TenantContext,
  input: AdvanceReworkInput,
  target: { propertyId: string; taskId: string; round: number },
): Promise<void> {
  if (input.action === "start") return;

  if (input.action === "complete") {
    await recordAudit(env, ctx, {
      actorId: input.actorId,
      action: "rework.resolved",
      targetType: "reworkCycle",
      targetId: input.reworkCycleId,
      propertyId: target.propertyId,
      after: { taskId: target.taskId, round: target.round },
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
    return;
  }

  // 免除。**理由必須**（`AUDIT_ACTIONS` の `rework.waived`）。
  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "rework.waived",
    targetType: "reworkCycle",
    targetId: input.reworkCycleId,
    propertyId: target.propertyId,
    after: {
      taskId: target.taskId,
      round: target.round,
      issueReportId: input.waive?.issueReportId ?? null,
      roomOutcome: input.waive?.roomOutcome ?? null,
    },
    reason: input.waive?.reason ?? "",
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  // 客室を動かしたことも残す（security.md §6「客室ステータスの手動上書き」。
  // **理由必須**なので免除の理由を持たせる）。
  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "room.statusOverridden",
    targetType: "reworkCycle",
    targetId: input.reworkCycleId,
    propertyId: target.propertyId,
    after: { taskId: target.taskId, housekeepingStatus: input.waive?.roomOutcome ?? null },
    reason: input.waive?.reason ?? "",
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });
}
