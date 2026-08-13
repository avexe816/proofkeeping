/**
 * 証跡 payload の材料を DB から集める（PK-SPEC-P2 §6.2）。
 *
 * task: docs/tasks/P2-08.md
 *
 * ── engine と分けてある理由 ──────────────────────────────
 * payload の**形**は `packages/engine`（純粋関数・テストで固定）。
 * ここは**材料を引く**だけで、形を決めない。分けておかないと
 * 「同入力 → 同ハッシュ」をテストするのに DB が要る。
 *
 * ── 引く行を増やさない ──────────────────────────────────
 * 証跡は業務操作の最後に書かれる。**そこで N+1 のクエリを撒くと、
 * 現場の完了操作が遅くなる**（CPU 50ms の予算 / CLAUDE.md §4）。
 * どの関数も引くのは固定回数で、項目ごとのループで DB を叩かない。
 */

import {
  listChecklistResults,
  listInspectionItemResults,
  listInspectionPhotos,
  listTaskPhotos,
  listTimeLogs,
  type Env,
  type TenantContext,
} from "@pk/db";
import {
  buildCleaningCompletionPayload,
  buildInspectionPayload,
  buildReworkCompletionPayload,
  reworkVisibleItemIds,
  type CanonicalValue,
  type EvidenceInspectionItemInput,
  type EvidencePhotoInput,
} from "@pk/engine";

/** 証跡に載せるタスクの素性。**呼び出し側が引いた行から詰める。** */
export interface EvidenceTaskInfo {
  taskId: string;
  propertyId: string;
  roomId: string;
  businessDate: string;
  taskType: string;
  /** 清掃担当者の `membership.id`。未割当なら `null`。 */
  assigneeId: string | null;
  actualMinutes: number | null;
}

/**
 * 清掃写真を証跡の形へ。
 *
 * `sha256` が `null` の行（P2-08 より前にアップロードされた写真）は
 * **そのまま `null` を載せる。** 後から計算して埋めない
 * （`schema/task.ts` の注記）。
 */
function toPhotoInputs(
  rows: readonly { id: string; sha256: string | null }[],
): EvidencePhotoInput[] {
  return rows.map((row) => ({ id: row.id, sha256: row.sha256 ?? "" }));
}

/**
 * 清掃完了の payload（`CLEANING_COMPLETION`）。
 *
 * `templateVersion` は展開時のテンプレート版（`taskChecklistResult`）。
 * **1 タスクに複数の版が混ざることはない**（1 回の展開で書かれる）が、
 * 万一混ざったら最大値を採る（後から足された項目の版）。
 */
export async function buildCleaningCompletionEvidence(
  env: Env,
  ctx: TenantContext,
  task: EvidenceTaskInfo,
  completedAtMs: number,
): Promise<CanonicalValue> {
  const [photos, timeLogs, results] = await Promise.all([
    listTaskPhotos(env, ctx, task.taskId),
    listTimeLogs(env, ctx, task.taskId),
    listChecklistResults(env, ctx, task.taskId),
  ]);

  const versions = results.map((row) => row.templateVersion);

  return buildCleaningCompletionPayload({
    taskId: task.taskId,
    roomId: task.roomId,
    businessDate: task.businessDate,
    taskType: task.taskType,
    cleanerId: task.assigneeId,
    completedAtMs,
    actualMinutes: task.actualMinutes,
    checklistTemplateVersion: versions.length === 0 ? null : Math.max(...versions),
    photos: toPhotoInputs(photos),
    // **並びは `listTimeLogs()` のまま**（`occurredAt` 昇順）。
    // 並べ替えると同じ操作から違うハッシュが出る。
    timeLogs: timeLogs.map((row) => ({
      event: row.event,
      atMs: row.occurredAt.getTime(),
      reasonCode: row.reasonCode,
    })),
  });
}

/** 証跡に載せる検査の素性。 */
export interface EvidenceInspectionInfo {
  inspectionId: string;
  round: number;
  inspectorId: string;
  result: string;
  startedAtMs: number;
  completedAtMs: number;
  durationSeconds: number | null;
  selfApproved: boolean;
  generalNote: string | null;
}

/**
 * 検査の payload（`INSPECTION_PASS` / `INSPECTION_FAIL`）。
 *
 * 項目の並びは**清掃時のチェックリストの定義順**に揃える。
 * `listInspectionItemResults()` は記録した順（検査者が触った順）で返すので、
 * そのまま使うと**同じ検査結果でも触った順が違えばハッシュが変わる。**
 */
export async function buildInspectionEvidence(
  env: Env,
  ctx: TenantContext,
  task: { taskId: string; roomId: string; businessDate: string },
  inspection: EvidenceInspectionInfo,
): Promise<CanonicalValue> {
  const [results, photos, cleaningResults] = await Promise.all([
    listInspectionItemResults(env, ctx, inspection.inspectionId),
    listInspectionPhotos(env, ctx, inspection.inspectionId),
    listChecklistResults(env, ctx, task.taskId),
  ]);

  const photosByItem = new Map<string, EvidencePhotoInput[]>();
  for (const photo of photos) {
    const bucket = photosByItem.get(photo.itemResultId);
    const entry = { id: photo.id, sha256: photo.sha256 };
    if (bucket === undefined) photosByItem.set(photo.itemResultId, [entry]);
    else bucket.push(entry);
  }

  const resultByItem = new Map(results.map((row) => [row.checklistItemId, row]));
  const items: EvidenceInspectionItemInput[] = [];
  // **清掃時の項目の順序で並べる**（`sortOrder` 昇順は `listChecklistResults()` が保証）。
  for (const cleaning of cleaningResults) {
    const judged = resultByItem.get(cleaning.itemId);
    if (judged === undefined) continue;
    items.push({
      checklistItemId: judged.checklistItemId,
      status: judged.status,
      defectCode: judged.defectCode,
      note: judged.note,
      reworkRequired: judged.reworkRequired,
      photos: photosByItem.get(judged.id) ?? [],
    });
  }

  return buildInspectionPayload({
    taskId: task.taskId,
    roomId: task.roomId,
    businessDate: task.businessDate,
    inspectionId: inspection.inspectionId,
    round: inspection.round,
    inspectorId: inspection.inspectorId,
    result: inspection.result,
    startedAtMs: inspection.startedAtMs,
    completedAtMs: inspection.completedAtMs,
    durationSeconds: inspection.durationSeconds,
    selfApproved: inspection.selfApproved,
    generalNote: inspection.generalNote,
    items,
  });
}

/** 証跡に載せる差戻しの素性。 */
export interface EvidenceReworkInfo {
  reworkCycleId: string;
  inspectionId: string;
  round: number;
  assignedToId: string;
  reasonSummary: string;
  startedAtMs: number | null;
  completedAtMs: number;
}

/**
 * 再清掃完了の payload（`REWORK_COMPLETION`）。
 *
 * `reworkItemIds` は**差し戻された項目**（§4.6）。`reworkVisibleItemIds()` で
 * 絞るのは M-12 の応答と同じ関数で、**画面に出したものと証跡が食い違わない**
 * ようにするため。
 *
 * 写真は再清掃で撮ったものだけに絞れない（`taskPhoto` は撮影時刻しか
 * 持たず、ラウンドの境目を持たない）。**タスクの写真を全部載せる。**
 * 差分は前ラウンドの `CLEANING_COMPLETION` / 前の `REWORK_COMPLETION` と
 * 突き合わせれば出る（証跡は連鎖しているので前の内容が残っている）。
 */
export async function buildReworkCompletionEvidence(
  env: Env,
  ctx: TenantContext,
  task: { taskId: string; roomId: string; businessDate: string },
  rework: EvidenceReworkInfo,
): Promise<CanonicalValue> {
  const [results, photos] = await Promise.all([
    listInspectionItemResults(env, ctx, rework.inspectionId),
    listTaskPhotos(env, ctx, task.taskId),
  ]);

  return buildReworkCompletionPayload({
    taskId: task.taskId,
    roomId: task.roomId,
    businessDate: task.businessDate,
    reworkCycleId: rework.reworkCycleId,
    inspectionId: rework.inspectionId,
    round: rework.round,
    assignedToId: rework.assignedToId,
    reasonSummary: rework.reasonSummary,
    startedAtMs: rework.startedAtMs,
    completedAtMs: rework.completedAtMs,
    reworkItemIds: reworkVisibleItemIds(
      results.map((row) => ({
        checklistItemId: row.checklistItemId,
        status: row.status,
        reworkRequired: row.reworkRequired,
      })),
    ),
    photos: toPhotoInputs(photos),
  });
}
