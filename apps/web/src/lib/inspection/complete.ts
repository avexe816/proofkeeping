/**
 * 検査の確定（PK-SPEC-P2 §4.4 合格 / §4.5 不合格）。
 *
 * task:  docs/tasks/P2-04.md
 * ルール: .claude/rules/security.md §6
 *
 * ── 呼ぶ順序 ────────────────────────────────────────────
 *   1. 検査を引く → タスクを引く（施設は資源から解決する / INV-32）
 *   2. `assertPermission("inspection.write")`
 *   3. 既に確定していれば、その結果をそのまま返す（再送 = 成功）
 *   4. 項目を並べて**完了の可否**を見る（§4.3 の 3 点）
 *   5. `aggregateResult()` で判定する（**人からは受け取らない**）
 *   6. `inspection` を確定（`result IS NULL` の行にだけ当たる）
 *   7. タスクへ反映（`AWAITING_INSPECTION` の行にだけ当たる）
 *   8. 客室ステータス → 不合格なら `reworkCycle` → 監査ログ → 錠を返す
 *
 * **4 を 6 より前に置くこと。** 順序を入れ替えると、拒否される完了で
 * 検査だけが確定する。
 *
 * ── D1 に跨るトランザクションが無い ─────────────────────
 * §4.4 は「1 トランザクションで実行する」と書くが、D1 の Workers API に
 * 複数文をまたぐトランザクションは無い。**代わりに各更新へ条件を載せて
 * ある**（`result IS NULL` / `status = AWAITING_INSPECTION` / 一意制約）。
 * 途中で落ちても二重に進まない形にしてあり、再送で続きから進む。
 * 検査を確定したあとに落ちた場合、タスクの状態は次の再送で反映される
 * （手順 3 が「確定済みだが未反映」を拾う）。
 *
 * ── 証跡（§4.4 / §4.5）─────────────────────────────────
 * `INSPECTION_PASS` / `INSPECTION_FAIL` の `EvidenceSnapshot` を、
 * **手順 8 のあと**（差戻しサイクルを作ったあと）に 1 件書く（P2-08）。
 * 順序が意味を持つ。証跡の payload に `reworkRequired` が入るので、
 * 差戻しの生成より前に書くと「差し戻したのに証跡には残っていない」
 * ラウンドができる余地がある。
 *
 * **証跡の失敗で検査を巻き戻さない。** 書けたかどうかは
 * `recordEvidence()` の戻り値に出る（`lib/evidence/record.ts` の注記）。
 */

import type { InspectionCompleteResponse, InspectionErrorCode } from "@pk/contracts";
import {
  applyInspectionOutcome,
  completeInspection,
  createReworkCycle,
  findInspectionById,
  findRoomById,
  findTaskById,
  NotFoundError,
  recordAudit,
  setHousekeepingStatus,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  aggregateResult,
  checkInspectionCompletion,
  durationSecondsOf,
  housekeepingStatusFor,
  reasonSummaryOf,
} from "@pk/engine";

import { assertPermission, propertyTarget } from "../auth/permission.js";
import { buildInspectionEvidence } from "../evidence/payload.js";
import { recordEvidence } from "../evidence/record.js";

import { listInspectionItems, toEngineItems, toInspection } from "./detail.js";
import { releaseInspectionLock } from "./lock.js";

/** 完了の入力。**判定を受け取らない**（§4.3 MUST）。 */
export interface CompleteInspectionUseCaseInput {
  inspectionId: string;
  /** 操作者の `membership.id`。 */
  actorId: string;
  generalNote?: string | undefined;
  ip?: string | undefined;
}

/** 完了の結果。 */
export type CompleteInspectionOutcome =
  | { kind: "OK"; body: InspectionCompleteResponse }
  | {
      kind: "REJECTED";
      error: InspectionErrorCode;
      details?: {
        unansweredItemIds?: string[];
        missingDefectCodeItemIds?: string[];
        missingNoteItemIds?: string[];
        missingPhotoItemIds?: string[];
      };
    };

/**
 * 検査を確定する。
 *
 * @throws {NotFoundError} 検査が無い・別テナント・権限が無い（すべて 404 / INV-31）。
 */
export async function completeInspectionUseCase(
  env: Env,
  ctx: TenantContext,
  input: CompleteInspectionUseCaseInput,
): Promise<CompleteInspectionOutcome> {
  const row = await findInspectionById(env, ctx, input.inspectionId);
  if (row === undefined) throw new NotFoundError();

  const task = await findTaskById(env, ctx, row.taskId);
  if (task === undefined) throw new NotFoundError();
  assertPermission(ctx, "inspection.write", propertyTarget([task.propertyId]));

  const room = await findRoomById(env, ctx, task.roomId);
  const taskInfo = {
    taskId: task.id,
    propertyId: task.propertyId,
    businessDate: task.businessDate,
    roomNumber: room?.roomNumber ?? "",
  };

  // 再送。**確定済みの検査は、その結果をそのまま返す。** 409 にすると
  // オフラインキューが赤バッジで止まる（ui-writing.md §5「409 は成功扱い」）。
  if (row.result !== null) {
    return {
      kind: "OK",
      body: {
        data: toInspection(row, taskInfo),
        result: row.result,
        taskStatus: task.status,
        reworkCycleId: null,
        unchanged: true,
      },
    };
  }

  // ── §4.3 の 3 点（理由コード・コメント・写真）と未選択の検査 ──
  const items = await listInspectionItems(env, ctx, row.id, row.taskId);
  const engineItems = toEngineItems(items);
  const check = checkInspectionCompletion(engineItems);
  if (!check.ok) {
    // **足りないものを 1 回で返す。** 直しては拒否される往復を作らない。
    return {
      kind: "REJECTED",
      error: check.unansweredItemIds.length > 0 ? "ITEMS_INCOMPLETE" : "DEFECT_DETAILS_REQUIRED",
      details: {
        unansweredItemIds: check.unansweredItemIds,
        missingDefectCodeItemIds: check.missingDefectCodeItemIds,
        missingNoteItemIds: check.missingNoteItemIds,
        missingPhotoItemIds: check.missingPhotoItemIds,
      },
    };
  }

  // **判定は集約でしか決まらない**（§4.3 MUST）。
  const result = aggregateResult(engineItems);

  const confirmed = await completeInspection(env, ctx, row.id, {
    result,
    durationSeconds: durationSecondsOf(row.startedAt.getTime(), ctx.now.getTime()),
    generalNote: input.generalNote ?? null,
  });
  if (!confirmed) {
    // 判定してから確定するまでの間に別の完了が着地した。**やり直さない。**
    const latest = await findInspectionById(env, ctx, row.id);
    const settled = latest?.result ?? result;
    return {
      kind: "OK",
      body: {
        data: toInspection(latest ?? row, taskInfo),
        result: settled,
        taskStatus: task.status,
        reworkCycleId: null,
        unchanged: true,
      },
    };
  }

  // ── タスクと客室（§4.4 / §4.5）─────────────────────────
  const moved = await applyInspectionOutcome(env, ctx, task.id, {
    result,
    round: row.round,
    inspectorId: row.inspectorId,
  });

  // **タスクを進めたときだけ客室を動かす。** 楽観的排他に負けた完了が
  // 客室だけ書き換える状態を作らない（`lib/task/transition.ts` と同じ順序）。
  if (moved) {
    const roomStatus = housekeepingStatusFor(
      result === "PASS" ? "inspectionPass" : "inspectionFail",
      true,
    );
    if (roomStatus !== null) await setHousekeepingStatus(env, ctx, [task.roomId], roomStatus);
  }

  // ── 差戻しサイクル（§4.5）──────────────────────────────
  // **不合格のときだけ作る。** 担当は元の清掃担当者（§3.4）。未割当なら
  // 検査者を入れる（誰にも紐づかない差戻しを作らない）。
  let reworkCycleId: string | null = null;
  if (result === "FAIL") {
    const created = await createReworkCycle(env, ctx, {
      taskId: task.id,
      propertyId: task.propertyId,
      inspectionId: row.id,
      round: row.round,
      assignedToId: task.assigneeId ?? input.actorId,
      reasonSummary: reasonSummaryOf(engineItems),
    });
    reworkCycleId = created?.id ?? null;
  }

  // ── 証跡（§4.4 / §4.5）──────────────────────────────────
  // **差戻しサイクルを作ったあと。** 検査を確定できた枝でだけ書く
  // （`confirmed` が偽の枝は上で戻っている）。
  await recordEvidence(env, ctx, {
    propertyId: task.propertyId,
    taskId: task.id,
    businessDate: task.businessDate,
    evidenceType: result === "PASS" ? "INSPECTION_PASS" : "INSPECTION_FAIL",
    payload: () =>
      buildInspectionEvidence(
        env,
        ctx,
        { taskId: task.id, roomId: task.roomId, businessDate: task.businessDate },
        {
          inspectionId: row.id,
          round: row.round,
          inspectorId: row.inspectorId,
          result,
          startedAtMs: row.startedAt.getTime(),
          completedAtMs: ctx.now.getTime(),
          durationSeconds: durationSecondsOf(row.startedAt.getTime(), ctx.now.getTime()),
          selfApproved: row.selfApproved,
          generalNote: input.generalNote ?? row.generalNote,
        },
      ),
    createdById: input.actorId,
  });

  await recordCompletionAudit(env, ctx, {
    actorId: input.actorId,
    inspectionId: row.id,
    taskId: task.id,
    propertyId: task.propertyId,
    round: row.round,
    result,
    reworkCycleId,
    ip: input.ip,
  });

  // 錠を返す。**失敗しても検査は成立している**（`lock.ts` の注記）。
  await releaseInspectionLock(env, ctx.organizationId, task.id, row.round);

  const latest = await findInspectionById(env, ctx, row.id);
  return {
    kind: "OK",
    body: {
      data: toInspection(latest ?? row, taskInfo),
      result,
      taskStatus: result === "PASS" ? "COMPLETED" : "REWORK",
      reworkCycleId,
      unchanged: !moved,
    },
  };
}

/**
 * 監査ログ（security.md §6「タスクの完了・検査合格・差戻し」）。
 *
 * 合格は `inspection.passed`、不合格は `inspection.failed`。差戻しが
 * 割り当たったときは `task.reworkAssigned` も残す（**誰の手に戻ったか**が
 * 追えないと、再清掃の滞留を追跡できない）。
 */
async function recordCompletionAudit(
  env: Env,
  ctx: TenantContext,
  input: {
    actorId: string;
    inspectionId: string;
    taskId: string;
    propertyId: string;
    round: number;
    result: "PASS" | "FAIL";
    reworkCycleId: string | null;
    ip?: string | undefined;
  },
): Promise<void> {
  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: input.result === "PASS" ? "inspection.passed" : "inspection.failed",
    targetType: "inspection",
    targetId: input.inspectionId,
    propertyId: input.propertyId,
    after: { taskId: input.taskId, round: input.round, result: input.result },
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });

  if (input.reworkCycleId === null) return;
  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action: "task.reworkAssigned",
    targetType: "reworkCycle",
    targetId: input.reworkCycleId,
    propertyId: input.propertyId,
    after: { taskId: input.taskId, round: input.round },
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });
}
