/**
 * 検査 1 件の応答を組み立てる（PK-SPEC-P2 §4.3）。
 *
 * task: docs/tasks/P2-04.md
 *
 * ── 検査項目は「作らずに並べる」──────────────────────────
 * §4.3 は「検査項目は清掃実施時に使った `TaskChecklistResult` の
 * スナップショットを基に生成する」。**行を先に作らない。**
 * `inspectionItemResult` に既定値つきの行を並べておくと、それが
 * 「全 PASS で初期化した検査」そのものになる（P2 固有の絶対ルール）。
 *
 * 画面に出す並びは `taskChecklistResult`（清掃時の項目）で、判定は
 * `inspectionItemResult` があればそれ、無ければ `null`（未選択）。
 * **行が無い＝まだ見ていない**（`schema/inspection.ts` の注記）。
 */

import type { Inspection, InspectionItem } from "@pk/contracts";
import {
  countInspectionPhotosByItem,
  listChecklistResults,
  listInspectionItemResults,
  listTemplateItems,
  type Env,
  type TenantContext,
} from "@pk/db";
import type { InspectionItemInput } from "@pk/engine";

/** 応答に要るタスクの情報。**呼び出し側が引いた行から詰める。** */
export interface InspectionTaskInfo {
  taskId: string;
  propertyId: string;
  businessDate: string;
  roomNumber: string;
}

/** `inspection` の行のうち、応答に使う列。 */
export interface InspectionRow {
  id: string;
  taskId: string;
  propertyId: string;
  round: number;
  inspectorId: string;
  result: "PASS" | "FAIL" | null;
  startedAt: Date;
  completedAt: Date | null;
  durationSeconds: number | null;
  selfApproved: boolean;
  generalNote: string | null;
}

/** 行 → 応答。**`idempotencyKey` と `overrideReason` を返さない。** */
export function toInspection(row: InspectionRow, task: InspectionTaskInfo): Inspection {
  return {
    inspectionId: row.id,
    taskId: row.taskId,
    propertyId: row.propertyId,
    roomNumber: task.roomNumber,
    businessDate: task.businessDate,
    round: row.round,
    inspectorId: row.inspectorId,
    result: row.result,
    startedAt: row.startedAt.getTime(),
    completedAt: row.completedAt?.getTime() ?? null,
    durationSeconds: row.durationSeconds,
    selfApproved: row.selfApproved,
    generalNote: row.generalNote,
  };
}

/**
 * 検査項目を並べる。
 *
 * 清掃時の項目（`taskChecklistResult`）を軸に、記録済みの判定と
 * 写真枚数を突き合わせる。**項目ごとにクエリを増やさない。**
 */
export async function listInspectionItems(
  env: Env,
  ctx: TenantContext,
  inspectionId: string,
  taskId: string,
): Promise<InspectionItem[]> {
  const [cleaningResults, recorded, photoCounts] = await Promise.all([
    listChecklistResults(env, ctx, taskId),
    listInspectionItemResults(env, ctx, inspectionId),
    countInspectionPhotosByItem(env, ctx, inspectionId),
  ]);

  const recordedByItem = new Map(recorded.map((row) => [row.checklistItemId, row]));
  const items = await listTemplateItems(
    env,
    ctx,
    [...new Set(cleaningResults.map((row) => row.itemId))],
  );
  const itemById = new Map(items.map((item) => [item.id, item]));

  return cleaningResults.map((row) => {
    const judged = recordedByItem.get(row.itemId);
    return {
      checklistItemId: row.itemId,
      section: itemById.get(row.itemId)?.section ?? "",
      labels: itemById.get(row.itemId)?.labels ?? {},
      status: judged?.status ?? null,
      defectCode: judged?.defectCode ?? null,
      note: judged?.note ?? null,
      reworkRequired: judged?.reworkRequired ?? false,
      photoCount: judged === undefined ? 0 : (photoCounts.get(judged.id) ?? 0),
      cleaningValue: row.value,
      sortOrder: row.sortOrder,
    };
  });
}

/** 応答の項目 → engine の入力。**集約の材料をここで揃える。** */
export function toEngineItems(items: readonly InspectionItem[]): InspectionItemInput[] {
  return items.map((item) => ({
    checklistItemId: item.checklistItemId,
    status: item.status,
    defectCode: item.defectCode,
    note: item.note,
    photoCount: item.photoCount,
  }));
}
