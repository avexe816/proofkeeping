/**
 * 観察記録の読み書き（PK-SPEC-P3 §3・§4.1・§7）。
 *
 * task: docs/tasks/P3-03.md / P3-04.md / P3-05.md
 *
 * ── ここが「タスクから解決する」層 ──────────────────────
 * API も画面も `propertyId` / `roomId` / `businessDate` を送らない。
 * すべてタスクの行から取る（INV-32）。**クライアントの申告を
 * `assertPermission()` に渡さない**ため、施設はここで確定させる。
 *
 * ── 既定値をサーバーで作る ──────────────────────────────
 * §3.3 の推定は `packages/engine` の純粋関数。**画面で組み立てない。**
 * 客室タイプと当日の稼働予定は端末に無く、送らせれば往復が増える
 * （§3.2 は start の直後に全画面で出す / DECISIONS #097）。
 */

import {
  type Observation,
  type ObservationConfig,
  type ObservationCounts,
  type ObservationDetailResponse,
} from "@pk/contracts";
import {
  findObservationByTaskId,
  findRoomById,
  findRoomTypeById,
  listObservationRevisions,
  listRoomPlans,
  skipObservation,
  upsertObservation,
  type Env,
  type TenantContext,
} from "@pk/db";
import { estimateObservationDefaults, type ObservationDefaults } from "@pk/engine";

import { resolveObservationConfig } from "./config.js";

/** タスクの行のうち、この層が使う列だけ。 */
export interface ObservationTask {
  id: string;
  propertyId: string;
  roomId: string;
  businessDate: string;
  observationSkipped: boolean;
}

/**
 * 既定値を推定する（§3.3）。
 *
 * 稼働予定・客室タイプが引けない場合も**必ず値を返す。** 判断は engine 側
 * （`estimateObservationDefaults()` の注記）。ここは材料を集めるだけ。
 */
export async function buildDefaults(
  env: Env,
  ctx: TenantContext,
  task: ObservationTask,
): Promise<{ defaults: ObservationDefaults; roomTypeId: string }> {
  const room = await findRoomById(env, ctx, task.roomId);
  const roomTypeId = room?.roomTypeId ?? "";
  const [roomType, plans] = await Promise.all([
    roomTypeId === "" ? Promise.resolve(undefined) : findRoomTypeById(env, ctx, roomTypeId),
    listRoomPlans(env, ctx, task.propertyId, task.businessDate),
  ]);

  const plan = plans.find((row) => row.roomId === task.roomId);

  return {
    roomTypeId,
    defaults: estimateObservationDefaults(
      plan === undefined
        ? null
        : {
            hasCheckout: plan.hasCheckout,
            isStayover: plan.isStayover,
            guestCount: plan.guestCount,
          },
      { bedCount: roomType?.bedCount ?? null, capacity: roomType?.capacity ?? null },
    ),
  };
}

/** 既定値を契約の形（`amenitiesUsed` を含む）へ広げる。 */
export function toCounts(defaults: ObservationDefaults): ObservationCounts {
  // **アメニティの既定は空。** 施設ごとに有効な品目が違い、engine は
  // 品目の一覧を知らない（`observationDefaults.ts` の注記）。
  return { ...defaults, amenitiesUsed: {} };
}

/** 観察記録の行を応答へ写す。 */
export function toObservation(
  row: NonNullable<Awaited<ReturnType<typeof findObservationByTaskId>>>,
  revisionCount: number,
): Observation {
  return {
    observationId: row.id,
    taskId: row.taskId,
    propertyId: row.propertyId,
    roomId: row.roomId,
    roomTypeId: row.roomTypeId,
    businessDate: row.businessDate,
    bedsUsed: row.bedsUsed,
    trashLevel: row.trashLevel,
    bathTowelUsed: row.bathTowelUsed,
    faceTowelUsed: row.faceTowelUsed,
    handTowelUsed: row.handTowelUsed,
    bathMatUsed: row.bathMatUsed,
    slippersUsed: row.slippersUsed,
    cupsUsed: row.cupsUsed,
    extraFutonUsed: row.extraFutonUsed,
    amenitiesUsed: row.amenitiesUsed,
    note: row.note,
    inputDurationMs: row.inputDurationMs,
    usedDefaults: row.usedDefaults,
    recordedAt: row.recordedAt.getTime(),
    revisionCount,
  };
}

/**
 * M-05 が開くときに要るものを 1 回で返す（§7 の `GET`）。
 *
 * 記録済みでも `defaults` を返す。M-05b が「既定から動かした項目」を
 * 出せるようにするため（画面の判断材料であって、警告ではない）。
 */
export async function buildObservationDetail(
  env: Env,
  ctx: TenantContext,
  task: ObservationTask,
): Promise<ObservationDetailResponse> {
  const [row, config, estimated] = await Promise.all([
    findObservationByTaskId(env, ctx, task.id),
    resolveObservationConfig(env, ctx, task.propertyId),
    buildDefaults(env, ctx, task),
  ]);

  const revisions = row === undefined ? [] : await listObservationRevisions(env, ctx, row.id);

  return {
    data: row === undefined ? null : toObservation(row, revisions.length),
    defaults: toCounts(estimated.defaults),
    config,
    skipped: task.observationSkipped,
  };
}

/** `recordObservation()` の入力（契約のリクエストと同じ形）。 */
export interface RecordObservationInput extends ObservationCounts {
  note?: string | undefined;
  inputDurationMs?: number | undefined;
  usedDefaults: boolean;
  clientTs?: number | undefined;
  recordedById: string;
  idempotencyKey?: string | undefined;
}

/** 記録の結果。**拒否は「施設が観察記録を止めている」場合だけ。** */
export type RecordObservationOutcome =
  | { kind: "RECORDED"; observationId: string; unchanged: boolean }
  | { kind: "REJECTED"; error: "OBSERVATION_DISABLED" };

/**
 * 入室時の観察を記録する（§4.1 / §7）。
 *
 * ── 施設が止めているときだけ断る ────────────────────────
 * `observationConfig.enabled = false` の施設では記録を受け付けない。
 * **それ以外に断る理由を作らない。** タスクの状態（開始前・完了後）で
 * 弾くと、オフラインで溜めた記録が復帰後に消える（§8 MUST
 * 「ここで記録が失われると P4 が成立しない」）。
 */
export async function recordObservation(
  env: Env,
  ctx: TenantContext,
  task: ObservationTask,
  input: RecordObservationInput,
): Promise<RecordObservationOutcome> {
  const config = await resolveObservationConfig(env, ctx, task.propertyId);
  if (!config.enabled) return { kind: "REJECTED", error: "OBSERVATION_DISABLED" };

  const { roomTypeId } = await buildDefaults(env, ctx, task);

  const result = await upsertObservation(env, ctx, {
    taskId: task.id,
    propertyId: task.propertyId,
    roomId: task.roomId,
    roomTypeId,
    businessDate: task.businessDate,
    bedsUsed: input.bedsUsed,
    trashLevel: input.trashLevel,
    bathTowelUsed: input.bathTowelUsed,
    faceTowelUsed: input.faceTowelUsed,
    handTowelUsed: input.handTowelUsed,
    bathMatUsed: input.bathMatUsed,
    slippersUsed: input.slippersUsed,
    cupsUsed: input.cupsUsed,
    extraFutonUsed: input.extraFutonUsed,
    amenitiesUsed: filterAmenities(input.amenitiesUsed, config),
    note: input.note ?? null,
    inputDurationMs: input.inputDurationMs ?? null,
    usedDefaults: input.usedDefaults,
    recordedById: input.recordedById,
    clientTs: input.clientTs ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  return { kind: "RECORDED", observationId: result.observationId, unchanged: result.unchanged };
}

/**
 * 「今回は記録しない」（§1.3 MUST / §7）。
 *
 * **理由を受け取らない。** 断る条件も無い（施設が止めていても、
 * 未記録として残ること自体に意味がある）。
 */
export async function skipObservationForTask(
  env: Env,
  ctx: TenantContext,
  task: ObservationTask,
): Promise<{ unchanged: boolean }> {
  return skipObservation(env, ctx, task.id);
}

/**
 * 施設で無効にした品目を落とす（§2.5 MUST）。
 *
 * 画面が出していない品目が本体に混ざっていても保存しない。
 * **「画面に出さない」だけを設定の実装にしない**（CLAUDE.md §5）。
 */
function filterAmenities(
  amenities: ObservationCounts["amenitiesUsed"],
  config: ObservationConfig,
): Record<string, number | boolean> {
  const enabled = new Set<string>(config.enabledItemCodes);
  return Object.fromEntries(Object.entries(amenities).filter(([code]) => enabled.has(code)));
}
