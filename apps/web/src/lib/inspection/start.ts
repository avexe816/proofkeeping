/**
 * 検査開始（PK-SPEC-P2 §4.2）。
 *
 * task:  docs/tasks/P2-04.md
 * ルール: .claude/rules/security.md §1
 *
 * ── 呼ぶ順序 ────────────────────────────────────────────
 *   1. タスクを引く（施設は**資源から解決する** / INV-32）
 *   2. `assertPermission("inspection.write")`
 *   3. `Idempotency-Key` の照合（再送なら既存の検査を返す）
 *   4. 状態の検査（`AWAITING_INSPECTION` 以外は断る）
 *   5. **自己検査の可否**（§4.2 の例外 / security.md §1）
 *   6. 既に開いている検査があればそれを返す（同じ検査者のみ）
 *   7. `InspectionLock` を取る（取れなければ `INSPECTION_ALREADY_STARTED`）
 *   8. `inspection` を INSERT（**一意制約が最後の防波堤**）
 *   9. 自己検査なら `recordAudit()`
 *
 * **5 を 7 より前に置くこと。** 順序を入れ替えると、断られる要求が
 * 錠を取ってしまい、正規の検査者が入れなくなる。
 */

import type { InspectionErrorCode } from "@pk/contracts";
import {
  createInspection,
  findInspectionByIdempotencyKey,
  findInspectionPolicy,
  findOpenInspectionByTask,
  findRoomById,
  findTaskById,
  NotFoundError,
  recordAudit,
  type Env,
  type TenantContext,
} from "@pk/db";
import { evaluateSelfInspection } from "@pk/engine";

import { assertPermission, propertyTarget } from "../auth/permission.js";

import { listInspectionItems, toInspection, type InspectionRow } from "./detail.js";
import { acquireInspectionLock } from "./lock.js";

import type { InspectionDetailResponse } from "@pk/contracts";

/** 検査開始の入力。**`round` を受け取らない**（§4.2 で決まる）。 */
export interface StartInspectionInput {
  taskId: string;
  /** 検査担当者の `membership.id`。 */
  inspectorId: string;
  overrideReason?: string | undefined;
  clientTs?: number | undefined;
  idempotencyKey?: string | undefined;
  ip?: string | undefined;
}

/** 検査開始の結果。 */
export type StartInspectionOutcome =
  | { kind: "OK"; body: InspectionDetailResponse }
  | { kind: "REJECTED"; error: InspectionErrorCode };

/**
 * 検査を開始する。
 *
 * @throws {NotFoundError} タスクが無い・別テナント・権限が無い（すべて 404 / INV-31）。
 */
export async function startInspection(
  env: Env,
  ctx: TenantContext,
  input: StartInspectionInput,
): Promise<StartInspectionOutcome> {
  const task = await findTaskById(env, ctx, input.taskId);
  // 資源が無いことと権限が無いことを区別しない（DECISIONS #022）。
  if (task === undefined) throw new NotFoundError();

  // **施設はタスクから解決した値を使う。** リクエストの値を渡さない（INV-32）。
  assertPermission(ctx, "inspection.write", propertyTarget([task.propertyId]));

  // 再送。**同じ鍵で作られた検査をそのまま返す。**
  if (input.idempotencyKey !== undefined) {
    const seen = await findInspectionByIdempotencyKey(env, ctx, input.idempotencyKey);
    if (seen !== undefined) return respond(env, ctx, seen, true);
  }

  // §4.1 の状態遷移。検査は `AWAITING_INSPECTION` からしか始まらない。
  if (task.status !== "AWAITING_INSPECTION") {
    return { kind: "REJECTED", error: "INVALID_TRANSITION" };
  }

  // ── 自己検査（§4.2 の例外 / security.md §1）─────────────
  // 施設の設定が無ければ**禁止側**（`propertyInspectionPolicy` の既定は
  // `selfInspectionAllowed = false`。行そのものが無い施設も同じ扱い）。
  const policy = await findInspectionPolicy(env, ctx, task.propertyId);
  const verdict = evaluateSelfInspection(
    task.assigneeId,
    input.inspectorId,
    policy?.selfInspectionAllowed ?? false,
    input.overrideReason ?? null,
  );
  if (verdict.kind === "FORBIDDEN") {
    return { kind: "REJECTED", error: "SELF_INSPECTION_FORBIDDEN" };
  }
  if (verdict.kind === "REASON_REQUIRED") {
    return { kind: "REJECTED", error: "REASON_REQUIRED" };
  }

  // 既に開いている検査。**同じ検査者なら入り直せる**（画面の再読み込み）。
  const open = await findOpenInspectionByTask(env, ctx, task.id);
  if (open !== undefined) {
    if (open.inspectorId !== input.inspectorId) {
      return { kind: "REJECTED", error: "INSPECTION_ALREADY_STARTED" };
    }
    return respond(env, ctx, open, true);
  }

  const round = task.currentInspectionRound + 1;

  // 錠。**取れなければ断る**（§4.2）。
  const lock = await acquireInspectionLock(env, {
    organizationId: ctx.organizationId,
    taskId: task.id,
    round,
    inspectorId: input.inspectorId,
    now: ctx.now,
  });
  if (!lock.acquired) return { kind: "REJECTED", error: "INSPECTION_ALREADY_STARTED" };

  const created = await createInspection(env, ctx, {
    taskId: task.id,
    propertyId: task.propertyId,
    round,
    inspectorId: input.inspectorId,
    selfApproved: verdict.selfApproved,
    overrideReason: verdict.selfApproved ? (input.overrideReason ?? null) : null,
    clientTs: input.clientTs === undefined ? null : new Date(input.clientTs),
    idempotencyKey: input.idempotencyKey ?? null,
  });

  if (created === undefined) {
    // 一意制約に当たった。**錠をすり抜けた経路**（binding 障害・別リージョン）。
    // 既存を引き直し、自分の検査ならそれを返す。
    const existing = await findOpenInspectionByTask(env, ctx, task.id);
    if (existing === undefined || existing.inspectorId !== input.inspectorId) {
      return { kind: "REJECTED", error: "INSPECTION_ALREADY_STARTED" };
    }
    return respond(env, ctx, existing, true);
  }

  // **自己検査は監査ログが要る**（security.md §1「緊急時の例外は理由必須＋
  // 監査ログ」）。理由は `evaluateSelfInspection()` が空でないことを保証済み。
  if (verdict.selfApproved) {
    await recordAudit(env, ctx, {
      actorId: input.inspectorId,
      action: "inspection.selfApproved",
      targetType: "inspection",
      targetId: created.id,
      propertyId: task.propertyId,
      after: { taskId: task.id, round },
      reason: input.overrideReason ?? "",
      ...(input.ip === undefined ? {} : { ip: input.ip }),
    });
  }

  const row = await findOpenInspectionByTask(env, ctx, task.id);
  if (row === undefined) throw new NotFoundError();
  return respond(env, ctx, row, false);
}

/** 応答を組み立てる。**項目は毎回並べ直す**（`inspectionItemResult` は作らない）。 */
async function respond(
  env: Env,
  ctx: TenantContext,
  row: InspectionRow,
  unchanged: boolean,
): Promise<StartInspectionOutcome> {
  const task = await findTaskById(env, ctx, row.taskId);
  if (task === undefined) throw new NotFoundError();
  const room = await findRoomById(env, ctx, task.roomId);

  return {
    kind: "OK",
    body: {
      data: toInspection(row, {
        taskId: task.id,
        propertyId: task.propertyId,
        businessDate: task.businessDate,
        roomNumber: room?.roomNumber ?? "",
      }),
      items: await listInspectionItems(env, ctx, row.id, row.taskId),
      unchanged,
    },
  };
}
