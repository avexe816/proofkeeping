/**
 * 消耗ベースラインの再計算（PK-SPEC-P3 §5）。**Queue コンシューマ。**
 *
 * task:  docs/tasks/P3-09.md
 * ルール: .claude/rules/architecture.md §3・§5 / testing.md §4
 *
 * ```
 * cron（日曜 03:00 JST） → 全アクティブ施設      → QUEUE_BASELINE_LEARNING
 * POST /api/v1/baselines/recompute（施設 1 つ）  → QUEUE_BASELINE_LEARNING
 *                                               ← ここで統計量を出して書く
 * ```
 *
 * ── なぜ Queue なのか ───────────────────────────────────
 * 90 日ぶんの観察（大きな施設で数万行）を読み、品目ごとに整列して
 * 百分位を取る。**リクエストハンドラの CPU 予算（50ms）に収まらない**
 * （architecture.md §5）。§5.1 も Queue を名指ししている。
 *
 * ── 冪等（testing.md §4）─────────────────────────────────
 * 同じメッセージを 3 回処理しても結果が変わらない。効いているのは 3 つ。
 *   ① 再計算方式。読み込んだ観察から**毎回すべてを出し直す**
 *      （インクリメントしない / architecture.md §3）。
 *   ② 書き込みは一意制約への upsert と、施設単位の置き換え
 *      （`repositories/baseline.ts`）。行が増えない。
 *   ③ `computeBaseline()` は決定性を持つ（入力順に依存せず、
 *      統計量を小数第 4 位で丸める / `packages/engine/src/baseline.ts`）。
 *
 * ── 手動上書きを消さない（§5.5 MUST）──────────────────
 * `replaceBaselines()` が `manualOverride` / `overrideReason` に触れない。
 * **ここで上書き列を書く経路を足さないこと。** 解除は W-21 だけが行う。
 *
 * ── 判定しない（§0.2）──────────────────────────────────
 * 出すのは統計量と除外記録だけ。「多い」「異常」を作らない。
 */

import { ITEM_CODES } from "@pk/contracts";
import {
  listLinenRecordsInRange,
  listObservations,
  listRoomPlansInRange,
  listTasks,
  replaceBaselineExclusions,
  replaceBaselines,
  type BaselineExclusionRowInput,
  type BaselineRowInput,
  type Env,
  type ItemCode,
  type TaskType,
  type TenantContext,
} from "@pk/db";
import {
  computeBaseline,
  toObservationSamples,
  type BaselineLinenInput,
  type BaselineObservationInput,
  type BaselineRoomPlanInput,
  type BaselineTaskInput,
} from "@pk/engine";

import { baselineWindowOf, businessDateChunks } from "../lib/baseline/window.js";

/** キューへ載せるメッセージ。**組織の解決に要る値を全部持たせる。** */
export interface BaselineLearningMessage {
  kind: "BASELINE_LEARNING";
  organizationId: string;
  orgShortId: string;
  propertyId: string;
  /** 集計ウィンドウの終端（業務日 `YYYY-MM-DD`）。 */
  computedTo: string;
  /** 集計ウィンドウの日数（§5.4）。範囲外は既定へ寄る。 */
  windowDays: number;
  /** `AUTO` は週次バッチ、`MANUAL` は §7 の手動再計算。 */
  mode: "AUTO" | "MANUAL";
  /** 手動再計算した `membership.id`。**`AUTO` では `null`。** */
  requestedById: string | null;
  /** 要求した時刻（ミリ秒）。**再送でも変わらない**（冒頭の「冪等」）。 */
  requestedAtMs: number;
}

/** メッセージの形を確かめる。**Zod を使わない**（contracts は API の入出力の定義）。 */
export function isBaselineLearningMessage(value: unknown): value is BaselineLearningMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  const requestedById = message["requestedById"];
  return (
    message["kind"] === "BASELINE_LEARNING" &&
    typeof message["organizationId"] === "string" &&
    typeof message["orgShortId"] === "string" &&
    typeof message["propertyId"] === "string" &&
    typeof message["computedTo"] === "string" &&
    typeof message["windowDays"] === "number" &&
    (message["mode"] === "AUTO" || message["mode"] === "MANUAL") &&
    (requestedById === null || typeof requestedById === "string") &&
    typeof message["requestedAtMs"] === "number"
  );
}

/** 1 件の処理結果。**呼び出し側（`queue()`）が ack / retry を決める。** */
export type BaselineLearningOutcome =
  | {
      kind: "OK";
      /** 書いたベースラインの行数。 */
      baselines: number;
      /** 記録した除外の件数。 */
      exclusions: number;
      /** 集計に使った観察 × 品目の件数。 */
      samples: number;
      /** タスク・稼働予定が見つからず捨てた観察の件数。 */
      dropped: number;
    }
  /** D1 の失敗など。**直しうる**ので retry する。 */
  | { kind: "FAILED"; reason: string };

/**
 * 施設 1 つぶんのベースラインを計算し直す。
 *
 * ── 分けて読む ──────────────────────────────────────────
 * 4 つの表を業務日で区切って読む（`lib/baseline/window.ts`）。
 * 1 本のクエリで 90 日ぶんを取ると、大きな施設で D1 の応答上限に当たる。
 *
 * ── 全品目の語彙を渡す ──────────────────────────────────
 * **施設設定（`enabledItemCodes`）で絞らない。** 設定から外した品目でも、
 * 蓄積済みの観察は統計として意味を持つ（W-20 の注記）。画面に出さない
 * ことと、集計しないことは別（外したあとで戻した施設が、また 20 件
 * 貯まるまで待つ形にしない）。
 */
export async function recomputeBaseline(
  env: Env,
  message: BaselineLearningMessage,
): Promise<BaselineLearningOutcome> {
  const ctx: TenantContext = {
    organizationId: message.organizationId,
    orgShortId: message.orgShortId,
    // バッチと同じ扱い（`consumers/dailyReport.ts` の注記 / OPEN_QUESTIONS #033）。
    // **`assertPermission()` は呼ばない。** 認可は投入した API 側で済んでいる。
    role: "ORG_ADMIN",
    allowedPropertyIds: [],
    now: new Date(message.requestedAtMs),
  };

  const window = baselineWindowOf(message.computedTo, message.windowDays);

  try {
    const observations: BaselineObservationInput[] = [];
    const tasks: BaselineTaskInput[] = [];
    const linenRecords: BaselineLinenInput[] = [];
    const roomPlans: BaselineRoomPlanInput[] = [];

    for (const chunk of businessDateChunks(window)) {
      for (const row of await listObservations(env, ctx, {
        propertyId: message.propertyId,
        from: chunk.from,
        to: chunk.to,
      })) {
        observations.push({
          observationId: row.id,
          propertyId: row.propertyId,
          taskId: row.taskId,
          roomId: row.roomId,
          roomTypeId: row.roomTypeId,
          businessDate: row.businessDate,
          bedsUsed: row.bedsUsed,
          bathTowelUsed: row.bathTowelUsed,
          faceTowelUsed: row.faceTowelUsed,
          handTowelUsed: row.handTowelUsed,
          bathMatUsed: row.bathMatUsed,
          slippersUsed: row.slippersUsed,
          amenitiesUsed: row.amenitiesUsed,
          inputDurationMs: row.inputDurationMs,
          recordedById: row.recordedById,
        });
      }

      for (const row of await listTasks(env, ctx, {
        propertyId: message.propertyId,
        businessDateFrom: chunk.from,
        businessDateTo: chunk.to,
      })) {
        tasks.push({
          taskId: row.id,
          roomId: row.roomId,
          businessDate: row.businessDate,
          taskType: row.taskType,
          observationSkipped: row.observationSkipped,
        });
      }

      for (const row of await listLinenRecordsInRange(env, ctx, {
        propertyId: message.propertyId,
        from: chunk.from,
        to: chunk.to,
      })) {
        linenRecords.push({
          taskId: row.taskId,
          itemCode: row.itemCode,
          collectedQty: row.collectedQty,
        });
      }

      for (const row of await listRoomPlansInRange(
        env,
        ctx,
        message.propertyId,
        chunk.from,
        chunk.to,
      )) {
        roomPlans.push({
          roomId: row.roomId,
          businessDate: row.businessDate,
          guestCount: row.guestCount,
        });
      }
    }

    const flattened = toObservationSamples({
      observations,
      tasks,
      linenRecords,
      roomPlans,
      itemCodes: ITEM_CODES,
    });

    const computed = computeBaseline(flattened.samples, {
      window: { from: window.from, to: window.to },
    });

    const rows: BaselineRowInput[] = computed.baselines.map((baseline) => ({
      roomTypeId: baseline.roomTypeId,
      guestCount: baseline.guestCount,
      taskType: baseline.taskType as TaskType,
      itemCode: baseline.itemCode as ItemCode,
      sampleSize: baseline.sampleSize,
      medianQty: baseline.medianQty,
      p10Qty: baseline.p10Qty,
      p90Qty: baseline.p90Qty,
      maxQty: baseline.maxQty,
      stdDev: baseline.stdDev,
      isReliable: baseline.isReliable,
    }));

    const exclusions: BaselineExclusionRowInput[] = computed.exclusions.map((exclusion) => ({
      observationId: exclusion.observationId,
      businessDate: exclusion.businessDate,
      roomTypeId: exclusion.roomTypeId,
      guestCount: exclusion.guestCount,
      taskType: exclusion.taskType as TaskType,
      itemCode: exclusion.itemCode as ItemCode,
      reason: exclusion.reason,
      qty: exclusion.qty,
    }));

    // **ベースラインが先、除外記録が後。** 逆にすると、途中で落ちたときに
    // 「除外だけ新しく、統計量は古い」状態になり、W-22 の除外率が
    // 別の集計の値を指す。
    await replaceBaselines(env, ctx, {
      propertyId: message.propertyId,
      computedFrom: window.from,
      computedTo: window.to,
      rows,
    });
    await replaceBaselineExclusions(env, ctx, {
      propertyId: message.propertyId,
      computedTo: window.to,
      rows: exclusions,
    });

    return {
      kind: "OK",
      baselines: rows.length,
      exclusions: exclusions.length,
      samples: flattened.samples.length,
      dropped: flattened.droppedNoTask + flattened.droppedNoRoomPlan,
    };
  } catch (error) {
    // **観察の中身をログへ流さない。** 例外の名前と業務日だけ。
    // 施設 ID は組織を含む自己記述 ID なので出さない（architecture.md §1）。
    const reason = error instanceof Error ? error.name : "UNKNOWN";
    console.error(`baseline-learning-failed to=${window.to} reason=${reason}`);
    return { kind: "FAILED", reason };
  }
}

/**
 * `baseline-learning` キューのハンドラ。
 *
 * **1 件ずつ ack / retry を決める。** バッチ全体を retry にすると、
 * 成功した施設まで計算し直すことになる（結果は同じだが CPU の無駄）。
 */
export async function handleBaselineLearningBatch(env: Env, batch: MessageBatch): Promise<void> {
  for (const message of batch.messages) {
    if (!isBaselineLearningMessage(message.body)) {
      // 形が違うものは**再送しても直らない。** ack して落とす。
      console.error("baseline-learning-invalid-message");
      message.ack();
      continue;
    }
    const outcome = await recomputeBaseline(env, message.body);
    if (outcome.kind === "FAILED") message.retry();
    else message.ack();
  }
}
