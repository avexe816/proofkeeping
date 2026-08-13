/**
 * 退室前のリネン記録（PK-SPEC-P3 §2.3・§4.3 / P3-06）。
 *
 * task: docs/tasks/P3-06.md
 *
 * ── 破損・汚損には写真が要る（§4.3 MUST）─────────────────
 * これは P5 の請求（弁償・追加費用）の根拠になる。**枚数だけの申告で
 * 請求の根拠にしない。** 判定はサーバー側で行い、画面の非活性に頼らない
 * （CLAUDE.md §5）。
 *
 * 断り方は **400（`PHOTO_REQUIRED`）で 409 にしない。** オフラインキューは
 * 409 を「処理済」として捨てるため（ui-writing.md §5）、写真より先に
 * リネン記録が届いた場合に記録そのものが消える。400 なら手元に残り、
 * 赤バッジから送り直せる（`lib/offline/policy.ts` の `verdictOf()`）。
 *
 * ── 写真はタスクの写真を数える ──────────────────────────
 * `linenRecord` に写真の列を作っていない（§2.3 にも無い）。M-06 は
 * タスクの写真（`POST /tasks/:id/photos`）へ 1 枚積んでから記録を送る。
 * キューは直列なので、通常は写真が先に着く（`lib/offline/queue.ts`）。
 */

import { LINEN_ITEM_CODES, type LinenEntry, type LinenListResponse } from "@pk/contracts";
import {
  listLinenRecords,
  listTaskPhotos,
  upsertLinenRecords,
  type Env,
  type TenantContext,
} from "@pk/db";

import { resolveObservationConfig } from "./config.js";
import type { ObservationTask } from "./record.js";

/** M-06 が読む内容（§4.3）。 */
export async function buildLinenResponse(
  env: Env,
  ctx: TenantContext,
  task: ObservationTask,
): Promise<LinenListResponse> {
  const [rows, config] = await Promise.all([
    listLinenRecords(env, ctx, task.id),
    resolveObservationConfig(env, ctx, task.propertyId),
  ]);

  return {
    taskId: task.id,
    data: rows.map((row) => ({
      linenRecordId: row.id,
      taskId: row.taskId,
      businessDate: row.businessDate,
      itemCode: row.itemCode,
      collectedQty: row.collectedQty,
      suppliedQty: row.suppliedQty,
      damagedQty: row.damagedQty,
      stainedQty: row.stainedQty,
      note: row.note,
      recordedAt: row.recordedAt.getTime(),
    })),
    // **リネンの品目だけを出す。** アメニティは M-05b の担当（§4.2）。
    enabledItemCodes: config.enabledItemCodes.filter((code) => isLinenItem(code)),
    requireLinen: config.requireLinen,
  };
}

/** 記録の結果。 */
export type RecordLinenOutcome =
  | { kind: "RECORDED"; applied: number }
  | { kind: "REJECTED"; error: "PHOTO_REQUIRED" };

/**
 * リネン枚数を記録する（§7 の `PUT /tasks/:id/linen`）。
 *
 * **施設設定で無効にした品目は保存しない**（§2.5 MUST）。画面が出して
 * いない品目が本体に混ざっていても落ちる。
 */
export async function recordLinen(
  env: Env,
  ctx: TenantContext,
  task: ObservationTask,
  input: { entries: readonly LinenEntry[]; recordedById: string },
): Promise<RecordLinenOutcome> {
  const config = await resolveObservationConfig(env, ctx, task.propertyId);
  const enabled = new Set<string>(config.enabledItemCodes);
  const entries = input.entries.filter(
    (entry) => enabled.has(entry.itemCode) && isLinenItem(entry.itemCode),
  );

  const reportsDamage = entries.some((entry) => entry.damagedQty > 0 || entry.stainedQty > 0);
  if (reportsDamage) {
    const photos = await listTaskPhotos(env, ctx, task.id);
    if (photos.length === 0) return { kind: "REJECTED", error: "PHOTO_REQUIRED" };
  }

  const applied = await upsertLinenRecords(env, ctx, {
    taskId: task.id,
    propertyId: task.propertyId,
    roomId: task.roomId,
    businessDate: task.businessDate,
    recordedById: input.recordedById,
    entries: entries.map((entry) => ({
      itemCode: entry.itemCode,
      collectedQty: entry.collectedQty,
      suppliedQty: entry.suppliedQty,
      damagedQty: entry.damagedQty,
      stainedQty: entry.stainedQty,
      note: entry.note ?? null,
    })),
  });

  return { kind: "RECORDED", applied };
}

/** `LINEN_ITEM_CODES` の集合。**語彙は契約が正**（二重定義しない）。 */
const LINEN_CODES: ReadonlySet<string> = new Set<string>(LINEN_ITEM_CODES);

/** リネンの品目か（§2.5 の前半 9 品目）。 */
function isLinenItem(code: string): boolean {
  return LINEN_CODES.has(code);
}
