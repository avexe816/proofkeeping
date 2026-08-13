/**
 * W-06 / W-07 の読み取り（PK-SPEC-P2 §12.1・§12.2・§12.3）。
 *
 * task: docs/tasks/P2-09.md
 *
 * ── 画面と API が同じ関数を通る ─────────────────────────
 * `/app/p/:propertyId/evidence*`（React Router の loader）と
 * `/api/v1/evidence*`（Hono）が同じものを返す。片方だけに絞りが入る形を
 * 作らない。**認可（`assertPermission()`）は呼び出し側**で、
 * ここは絞りの掛かった `ctx` を受け取って読むだけ。
 *
 * ── タイムラインは業務の記録から組む ────────────────────
 * `buildEvidenceTimeline()`（`packages/engine`）へ渡す材料を集める。
 * **証跡の `payload` を parse しない**（`evidenceTimeline.ts` 冒頭）。
 *
 * ── 氏名を持ち回らない ──────────────────────────────────
 * 返すのは `membership.id` だけ。表示名への写像は画面が
 * `canViewStaffName()` を通して行う（INV-06）。ここで氏名を混ぜると、
 * API を叩いた `OWNER` に氏名が出る経路ができる。
 */

import type { EvidenceSnapshotSummary } from "@pk/contracts";
import {
  listEvidenceSnapshotsByTask,
  listInspectionsByTask,
  listReworkCyclesByTask,
  listTasks,
  listTimeLogs,
  type Env,
  type TenantContext,
} from "@pk/db";
import { buildEvidenceTimeline, type TimelineEntry } from "@pk/engine";

/** W-06 の 1 行。**タスク 1 件 = 1 行。** */
export interface EvidenceListRow {
  taskId: string;
  roomId: string;
  businessDate: string;
  taskType: string;
  status: string;
  /** そのタスクに残っている証跡の件数。**0 件もそのまま出す。** */
  snapshotCount: number;
  /** 連鎖の末尾のハッシュ。証跡が無ければ `null`。 */
  chainHash: string | null;
}

/** W-07 の中身。 */
export interface EvidenceDetail {
  taskId: string;
  propertyId: string;
  roomId: string;
  businessDate: string;
  taskType: string;
  status: string;
  assigneeId: string | null;
  timeline: readonly TimelineEntry[];
  snapshots: readonly EvidenceSnapshotSummary[];
  /** 検査（ラウンド順）。**判定と検査者だけ。項目は M-09 が持つ。** */
  inspections: readonly {
    inspectionId: string;
    round: number;
    inspectorId: string;
    result: "PASS" | "FAIL" | null;
    selfApproved: boolean;
  }[];
  /** 差戻し（ラウンド順）。 */
  reworkCycles: readonly {
    reworkCycleId: string;
    round: number;
    assignedToId: string;
    status: string;
    reasonSummary: string;
    waivedById: string | null;
    waivedReason: string | null;
  }[];
}

/**
 * W-06 の一覧（§12.1）。**施設と業務日で引く。**
 *
 * 業務日を必須にしてあるのは、証跡が積み上がる表だから。
 * 施設だけで引ける口にすると、1 施設あたり数万件を数える経路ができる
 * （architecture.md §3 の「テナント横断・施設横断の集計は rollup」と
 * 同じ理由で、ここは 1 日に閉じる）。
 */
export async function listEvidenceForProperty(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
  businessDate: string,
): Promise<EvidenceListRow[]> {
  const tasks = await listTasks(env, ctx, { propertyId, businessDate });

  // **タスクごとに 1 回引く。** 業務日 1 日ぶん（100 室程度）を想定する。
  // これ以上増えるなら rollup を持つべきで、その判断は §10.1 の担当。
  const rows = await Promise.all(
    tasks.map(async (task) => {
      const snapshots = await listEvidenceSnapshotsByTask(env, ctx, task.id);
      return {
        taskId: task.id,
        roomId: task.roomId,
        businessDate: task.businessDate,
        taskType: task.taskType,
        status: task.status,
        snapshotCount: snapshots.length,
        chainHash: snapshots.at(-1)?.chainHash ?? null,
      };
    }),
  );

  return rows;
}

/**
 * W-07 の中身（§12.2）。
 *
 * @param task 呼び出し側が引いた `cleaningTask` の行。**ここで引き直さない**
 *   （認可の判定に使った行と別の行を読む形にしない）。
 */
export async function loadEvidenceDetail(
  env: Env,
  ctx: TenantContext,
  task: {
    id: string;
    propertyId: string;
    roomId: string;
    businessDate: string;
    taskType: string;
    status: string;
    assigneeId: string | null;
  },
): Promise<EvidenceDetail> {
  const [timeLogs, inspections, reworkCycles, snapshots] = await Promise.all([
    listTimeLogs(env, ctx, task.id),
    listInspectionsByTask(env, ctx, task.id),
    listReworkCyclesByTask(env, ctx, task.id),
    listEvidenceSnapshotsByTask(env, ctx, task.id),
  ]);

  const timeline = buildEvidenceTimeline({
    timeLogs: timeLogs.map((row) => ({
      event: row.event,
      atMs: row.occurredAt.getTime(),
      reasonCode: row.reasonCode,
      actorId: row.actorId,
    })),
    inspections: inspections.map((row) => ({
      inspectionId: row.id,
      round: row.round,
      inspectorId: row.inspectorId,
      result: row.result,
      startedAtMs: row.startedAt.getTime(),
      completedAtMs: row.completedAt?.getTime() ?? null,
    })),
    reworkCycles: reworkCycles.map((row) => ({
      reworkCycleId: row.id,
      round: row.round,
      assignedToId: row.assignedToId,
      status: row.status,
      startedAtMs: row.startedAt?.getTime() ?? null,
      completedAtMs: row.completedAt?.getTime() ?? null,
      // **免除時刻の列が無い**ので `updatedAt` を渡す
      // （`evidenceTimeline.ts` の `waivedAtMs` の注記）。
      waivedAtMs: row.status === "WAIVED" ? row.updatedAt.getTime() : null,
    })),
  });

  return {
    taskId: task.id,
    propertyId: task.propertyId,
    roomId: task.roomId,
    businessDate: task.businessDate,
    taskType: task.taskType,
    status: task.status,
    assigneeId: task.assigneeId,
    timeline,
    snapshots: snapshots.map(toSnapshotSummary),
    inspections: inspections.map((row) => ({
      inspectionId: row.id,
      round: row.round,
      inspectorId: row.inspectorId,
      result: row.result,
      selfApproved: row.selfApproved,
    })),
    reworkCycles: reworkCycles.map((row) => ({
      reworkCycleId: row.id,
      round: row.round,
      assignedToId: row.assignedToId,
      status: row.status,
      reasonSummary: row.reasonSummary,
      waivedById: row.waivedById,
      waivedReason: row.waivedReason,
    })),
  };
}

/**
 * 行 → 応答の形。**`payload` を載せない**（`contracts/evidence.ts` の注記）。
 *
 * 正規化 JSON は再ハッシュに使う値で、一覧に載せると画面が
 * `JSON.parse` → 再表示で並びを崩す誘惑が生まれる。
 */
function toSnapshotSummary(row: {
  id: string;
  taskId: string | null;
  businessDate: string;
  evidenceType: EvidenceSnapshotSummary["evidenceType"];
  schemaVersion: string;
  payloadSha256: string;
  previousHash: string | null;
  chainHash: string;
  correctsSnapshotId: string | null;
  correctionReason: string | null;
  createdAt: Date;
}): EvidenceSnapshotSummary {
  return {
    snapshotId: row.id,
    taskId: row.taskId,
    businessDate: row.businessDate,
    evidenceType: row.evidenceType,
    schemaVersion: row.schemaVersion,
    payloadSha256: row.payloadSha256,
    previousHash: row.previousHash,
    chainHash: row.chainHash,
    correctsSnapshotId: row.correctsSnapshotId,
    correctionReason: row.correctionReason,
    createdAt: row.createdAt.getTime(),
  };
}
