/**
 * 状態遷移の実行（PK-SPEC-P1 §5）。
 *
 * task: docs/tasks/P1-05.md
 *
 * ── 呼ぶ順序 ────────────────────────────────────────────
 *   1. タスクを引く（施設は**資源から解決する** / INV-32）
 *   2. `assertPermission()`（サーバー側判定 / security.md §1）
 *   3. `Idempotency-Key` の照合（再送なら何もしない）
 *   4. 状態機械の判定（`packages/engine`）
 *   5. `complete` なら必須チェック・写真必須の検証（§5.3 の 2 つの MUST）
 *   6. `complete` なら検査の要否を決める（PK-SPEC-P2 §2.2。**ここでだけ**）
 *   7. 時間ログの追記 → 実作業時間の再計算 → 状態の更新
 *   8. `recordAudit()`
 *
 * **5 を 7 より前に置くこと。** 順序を入れ替えると、拒否された完了操作の
 * 時間ログだけが残る。
 */

import type { TaskActionValue, TaskErrorCode } from "@pk/contracts";
import {
  appendTimeLog,
  applyTransition,
  countPhotosByChecklistItem,
  findPropertyById,
  findTaskById,
  findTimeLogByIdempotencyKey,
  listChecklistResults,
  listTimeLogs,
  NotFoundError,
  recordAudit,
  setHousekeepingStatus,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  actualMinutesOf,
  checkCompletion,
  evaluateTransition,
  housekeepingStatusFor,
  requiresReasonCode,
  summarizeTimeLogs,
  timeEventOf,
  type TaskStatusValue,
} from "@pk/engine";

import { assertPermission, propertyTarget } from "../auth/permission.js";
import { buildCleaningCompletionEvidence } from "../evidence/payload.js";
import { recordEvidence } from "../evidence/record.js";

import { resolveInspectionDecision } from "./inspectionDecision.js";

/** 遷移の入力。**`propertyId` を受け取らない**（資源から解決する / INV-32）。 */
export interface TransitionInput {
  taskId: string;
  action: TaskActionValue;
  /** 操作者の `membership.id`。 */
  actorId: string;
  reasonCode?: string | undefined;
  assigneeId?: string | undefined;
  clientTs?: number | undefined;
  note?: string | undefined;
  idempotencyKey?: string | undefined;
  ip?: string | undefined;
}

/** 遷移の結果。 */
export type TransitionOutcome =
  | { kind: "OK"; taskId: string; status: TaskStatusValue; unchanged: boolean }
  | {
      kind: "REJECTED";
      error: TaskErrorCode;
      incompleteItemIds?: string[];
      missingPhotoItemIds?: string[];
    };

/** その操作が要求する権限。§5.3 の「実行可能なロール」列。 */
function permissionFor(action: TaskActionValue): "task.write" | "task.manage" {
  return action === "assign" || action === "cancel" ? "task.manage" : "task.write";
}

/**
 * タスクの状態を変える。
 *
 * @throws {NotFoundError} タスクが無い・別テナント・権限が無い（すべて 404 / INV-31）。
 */
export async function runTransition(
  env: Env,
  ctx: TenantContext,
  input: TransitionInput,
): Promise<TransitionOutcome> {
  const task = await findTaskById(env, ctx, input.taskId);
  // 資源が無いことと権限が無いことを区別しない（DECISIONS #022）。
  if (task === undefined) throw new NotFoundError();

  // **施設はタスクから解決した値を使う。** リクエストの値を渡さない（INV-32）。
  assertPermission(ctx, permissionFor(input.action), propertyTarget([task.propertyId]));

  if (requiresReasonCode(input.action) && (input.reasonCode ?? "") === "") {
    return { kind: "REJECTED", error: "REASON_REQUIRED" };
  }
  if (input.action === "assign" && input.assigneeId === undefined) {
    return { kind: "REJECTED", error: "INVALID_REQUEST" };
  }

  // 再送。**状態を変えず、いまの状態を返す。** オフラインキューは
  // これを成功として扱ってキューから消す（§8.2）。
  if (input.idempotencyKey !== undefined) {
    const seen = await findTimeLogByIdempotencyKey(env, ctx, input.idempotencyKey);
    if (seen !== undefined) {
      return { kind: "OK", taskId: task.id, status: task.status, unchanged: true };
    }
  }

  // **検査の要否は施設の設定**（§5.2 / PK-SPEC-P2 §2）。タスクは持たない。
  // 施設が引けない場合は検査不要として扱う（`complete` が滞留しない側へ倒す）。
  const property = await findPropertyById(env, ctx, task.propertyId);

  // ── `evaluateTransition()` を 2 回呼ぶ ──────────────────────
  // 拒否と再送（NOOP）の判定は**現在の状態だけ**で決まり、検査の要否に
  // 依らない。先にそれを見てから抽出の判定へ進む。順序を逆にすると、
  // オフラインキューが再送した `complete` のたびに抽選をやり直すことになる
  // （結果は捨てるので害は無いが、DB を 3 回引く）。
  const preliminary = evaluateTransition(task.status, input.action, false);
  if (preliminary.kind === "REJECTED") {
    return { kind: "REJECTED", error: "INVALID_TRANSITION" };
  }
  if (preliminary.kind === "NOOP") {
    return { kind: "OK", taskId: task.id, status: task.status, unchanged: true };
  }

  // **必須チェック・写真必須の検証は抽出の判定より前**（冒頭の「呼ぶ順序」）。
  // 拒否される完了で抽選を回すと、その日の抽出済み件数の数え方に効く条件を
  // 検証の前に触ることになる。
  if (input.action === "complete") {
    const rejection = await verifyCompletion(env, ctx, task.id);
    if (rejection !== null) return rejection;
  }

  // ── 検査の要否は `complete` のときにだけ決める（PK-SPEC-P2 §2.2 MUST）──
  // 他の操作では判定そのものを行わない。判定していない値は漏れない。
  const inspection =
    input.action === "complete"
      ? await resolveInspectionDecision(
          env,
          ctx,
          {
            taskId: task.id,
            propertyId: task.propertyId,
            roomId: task.roomId,
            businessDate: task.businessDate,
            reworkCount: task.reworkCount,
            cleanerId: task.assigneeId ?? input.actorId,
          },
          property?.inspectionRequired ?? false,
        )
      : null;

  const inspectionRequired = inspection?.required ?? false;
  const decision = evaluateTransition(task.status, input.action, inspectionRequired);
  if (decision.kind !== "MOVE") {
    // 1 回目が MOVE だった以上ここへは来ない。`to` を取り出すために書く。
    return { kind: "OK", taskId: task.id, status: task.status, unchanged: true };
  }

  const event = timeEventOf(input.action);
  if (event !== null) {
    await appendTimeLog(env, ctx, {
      taskId: task.id,
      propertyId: task.propertyId,
      event,
      actorId: input.actorId,
      reasonCode: input.reasonCode,
      clientTs: input.clientTs === undefined ? undefined : new Date(input.clientTs),
      idempotencyKey: input.idempotencyKey,
    });
  }

  // **時間ログを書いてから読み直す。** `actualMinutes` はキャッシュなので、
  // 追記した 1 件を含めた並び全体から作り直す（§2.2）。
  const summary = summarizeTimeLogs(
    (await listTimeLogs(env, ctx, task.id)).map((row) => ({
      event: row.event,
      occurredAt: row.occurredAt.getTime(),
    })),
  );

  const moved = await applyTransition(env, ctx, task.id, task.status, {
    status: decision.to,
    ...(input.action === "assign"
      ? { assigneeId: input.assigneeId ?? null, assignedAt: ctx.now }
      : {}),
    ...(summary.startedAt === null ? {} : { startedAt: new Date(summary.startedAt) }),
    ...(summary.completedAt === null ? {} : { completedAt: new Date(summary.completedAt) }),
    ...(input.action === "cancel" ? { cancelledAt: ctx.now } : {}),
    ...(input.action === "block" ? { blockedReason: input.reasonCode ?? null } : {}),
    ...(input.action === "unblock" ? { blockedReason: null } : {}),
    ...(input.note === undefined ? {} : { note: input.note }),
    // 要否と省略理由は必ず一組で書く（`ApplyTransitionInput` の注記）。
    // **「検査なし」を「検査合格」にしない**ので `inspectionResult` は触らない。
    ...(inspection === null
      ? {}
      : {
          inspection: {
            required: inspection.required,
            skipped: !inspection.required,
            skipReason: inspection.required ? null : inspection.skipReason,
          },
        }),
    actualMinutes: Math.floor(summary.workedMs / 60_000),
    pauseCount: summary.pauseCount,
  });

  if (!moved) {
    // 判定してから更新するまでの間に別の操作が着地した（楽観的排他）。
    // **時間ログは既に書かれている。** 消さない（INV-27 と同じ考え方で、
    // 記録は残す）。呼び出し側には「変わらなかった」として返す。
    return { kind: "OK", taskId: task.id, status: task.status, unchanged: true };
  }

  // 客室ステータスの同期（§11.1 / P1-16）。**状態を進めたあとに行う。**
  // 先に客室を動かすと、楽観的排他に負けた操作が客室だけ書き換える。
  // 自動同期は `AuditLog` に残さない（元の操作が既に残っている）。
  // **検査の要否は施設の設定ではなく、いま決めた判定を渡す。** SAMPLE で
  // 抽出されなかったタスクは検査を経ずに完了するので、客室も READY へ進む。
  const roomStatus = housekeepingStatusFor(input.action, inspectionRequired);
  if (roomStatus !== null) {
    await setHousekeepingStatus(env, ctx, [task.roomId], roomStatus);
  }

  // ── 証跡（PK-SPEC-P2 §3.7 / §6.2 / P2-08）───────────────
  // **最初の清掃完了だけ。** 2 回目以降の `complete` は再清掃の完了で、
  // そちらは `REWORK_COMPLETION` として `lib/rework/advance.ts` が書く
  // （§6.5 の ZIP は `cleaning-completion.json` を 1 件しか持たない）。
  // 判定に `reworkCount` を使えるのは、この値が検査不合格のときにしか
  // 増えないため（`applyInspectionOutcome()`）。
  if (input.action === "complete" && task.reworkCount === 0) {
    await recordEvidence(env, ctx, {
      propertyId: task.propertyId,
      taskId: task.id,
      businessDate: task.businessDate,
      evidenceType: "CLEANING_COMPLETION",
      payload: () =>
        buildCleaningCompletionEvidence(
          env,
          ctx,
          {
            taskId: task.id,
            propertyId: task.propertyId,
            roomId: task.roomId,
            businessDate: task.businessDate,
            taskType: task.taskType,
            assigneeId: task.assigneeId,
            actualMinutes: Math.floor(summary.workedMs / 60_000),
          },
          summary.completedAt ?? ctx.now.getTime(),
        ),
      createdById: input.actorId,
    });
  }

  await recordTransitionAudit(env, ctx, input, task.propertyId, task.status, decision.to);

  return { kind: "OK", taskId: task.id, status: decision.to, unchanged: false };
}

/**
 * `complete` の 2 つの MUST（§5.3）。
 *
 * @returns 拒否なら理由つきの結果。通ってよければ `null`。
 */
async function verifyCompletion(
  env: Env,
  ctx: TenantContext,
  taskId: string,
): Promise<TransitionOutcome | null> {
  const [results, photoCounts] = await Promise.all([
    listChecklistResults(env, ctx, taskId),
    countPhotosByChecklistItem(env, ctx, taskId),
  ]);

  const check = checkCompletion(
    results.map((row) => ({
      itemId: row.itemId,
      isRequired: row.isRequired,
      photoRequired: row.photoRequired,
      value: row.value,
      photoCount: photoCounts.get(row.itemId) ?? 0,
    })),
  );
  if (check.ok) return null;

  // **未完了と写真不足を 1 回で返す。** 直しては拒否される往復を作らない。
  return {
    kind: "REJECTED",
    error: check.incompleteItemIds.length > 0 ? "CHECKLIST_INCOMPLETE" : "PHOTO_REQUIRED",
    incompleteItemIds: check.incompleteItemIds,
    missingPhotoItemIds: check.missingPhotoItemIds,
  };
}

/**
 * 監査ログ。**記録するのは security.md §6 と §4.2・§5.3 に根拠のある操作だけ。**
 *
 * `start` / `pause` / `resume` を監査ログに載せない。清掃員の操作履歴を
 * 記録の目的以外に使えてしまう（INV-07）。作業時間は `taskTimeLog` にあり、
 * そちらは業務の記録として本人が見られる（M-11）。
 */
async function recordTransitionAudit(
  env: Env,
  ctx: TenantContext,
  input: TransitionInput,
  propertyId: string,
  before: string,
  after: string,
): Promise<void> {
  const action =
    input.action === "complete"
      ? "task.completed"
      : input.action === "assign"
        ? "task.assigned"
        : input.action === "cancel"
          ? "task.cancelled"
          : input.action === "block"
            ? "task.blocked"
            : null;
  if (action === null) return;

  await recordAudit(env, ctx, {
    actorId: input.actorId,
    action,
    targetType: "cleaningTask",
    targetId: input.taskId,
    propertyId,
    before: { status: before },
    after: { status: after, ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }) },
    ...(input.reasonCode === undefined ? {} : { reason: input.reasonCode }),
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  });
}

/** タスクの実作業時間（分）。表示用。`actualMinutes` の再計算にも使う。 */
export async function currentActualMinutes(
  env: Env,
  ctx: TenantContext,
  taskId: string,
): Promise<number> {
  const logs = await listTimeLogs(env, ctx, taskId);
  return actualMinutesOf(
    logs.map((row) => ({ event: row.event, occurredAt: row.occurredAt.getTime() })),
  );
}
