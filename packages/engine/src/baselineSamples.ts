/**
 * 観察記録・リネン記録を「品目 1 つぶんの観察値」へ平らにする（PK-SPEC-P3 §5.2）。
 * **純粋関数。**
 *
 * task: docs/tasks/P3-09.md
 *
 * ── なぜ engine に置くのか ──────────────────────────────
 * `computeBaseline()` の入力は `ObservationSample[]`（品目 1 つ × 観察 1 件）
 * だが、DB にあるのは「1 タスク 1 行・品目は列と JSON」という形の
 * `roomObservation` と、品目ごとに行を持つ `linenRecord` の 2 つ。
 * **この変換にルールがある**（下の 3 つ）ので、週次バッチの中に
 * 埋め込まず、テストできる純粋関数として切り出す。
 *
 * ── 1 タスク × 1 品目 = 1 サンプル ──────────────────────
 * 同じ品目が複数の経路から来る（バスタオルは `bathTowelUsed` 列にも
 * `linenRecord` にもある）。**両方を積むと同じ観察が二重に効く**ので、
 * 経路に優先順位を付けて 1 つだけ採る。
 *
 *   ① `roomObservation` の列（`bathTowelUsed` 等）
 *   ② `roomObservation.amenitiesUsed`（JSON）
 *   ③ `linenRecord.collectedQty`
 *
 * ①が最優先なのは、入室時の観察が §5 の主入力だから（§3.1「入室直後」）。
 * ③は①②に列の無い品目（シーツ・枕カバー・浴衣）を拾うために要る。
 *
 * ── 観察の無いタスクは採らない ──────────────────────────
 * リネンだけ記録されたタスクは**サンプルにしない。** §5.2 の除外は
 * `observationSkipped` と `bedsUsed` を見ており、観察が無いと
 * どちらも判定できない（`bedsUsed` を 0 とみなすと、実際に使われた
 * 部屋が「入力漏れ」として消える）。
 *
 * ── 稼働予定の無い観察は採らない ────────────────────────
 * 集計キーに `guestCount` が入る（§5.2 の 2.）。`dailyRoomPlan` が
 * 無い観察は人数が分からず、0 名（＝空室）へ寄せると空室の
 * ベースラインが埋まる。**捨てた件数を返して呼び出し側が記録する**
 * （docs/DECISIONS.md #101）。
 *
 * ── 品目コードの語彙をここに書かない ────────────────────
 * `packages/contracts` の `ITEM_CODES` が唯一の定義（CLAUDE.md §5）。
 * engine は依存を持てないので、**呼び出し側が語彙を渡す。**
 * 語彙に無いキー（施設が独自に入れた JSON のキー等）は捨てる。
 */

import type { ObservationSample } from "./baseline.js";

/**
 * `roomObservation` の数値列 → 品目コード（§2.1 / §2.5）。
 *
 * ── 値は列から来る。JSON は経由しない ───────────────────
 * `amenitiesUsed`（JSON）は施設が `enabledItemCodes` で有効にした品目だけを
 * 運ぶ別の経路。**ここに載っている品目は、施設の設定に関わらず列から拾う**
 * （`SLIPPERS` が先例）。同じコードが両方から来ても、集計側が列を先に処理し
 * `taken` で重複を防ぐ。
 *
 * ── `cupsUsed` / `extraFutonUsed` を足した（#061 解決）───
 * 列は migration 0012 以降ずっと記録されていて、**§2.5 の語彙に無かった
 * だけ**だった。`CUP` / `EXTRA_FUTON` を足したので、過去のぶんも次回の
 * 集計から標本になる（DECISIONS #252）。
 */
export const OBSERVATION_ITEM_COLUMNS = [
  { column: "bathTowelUsed", itemCode: "BATH_TOWEL" },
  { column: "faceTowelUsed", itemCode: "FACE_TOWEL" },
  { column: "handTowelUsed", itemCode: "HAND_TOWEL" },
  { column: "bathMatUsed", itemCode: "BATH_MAT" },
  { column: "slippersUsed", itemCode: "SLIPPERS" },
  { column: "cupsUsed", itemCode: "CUP" },
  { column: "extraFutonUsed", itemCode: "EXTRA_FUTON" },
] as const;

/** 平らにする対象の観察記録 1 件。**`roomObservation` の必要な列だけ。** */
export interface BaselineObservationInput {
  observationId: string;
  propertyId: string;
  taskId: string;
  roomId: string;
  roomTypeId: string;
  businessDate: string;
  bedsUsed: number;
  bathTowelUsed: number;
  faceTowelUsed: number;
  handTowelUsed: number;
  bathMatUsed: number;
  slippersUsed: number;
  // DECISIONS #252 で語彙に載った 2 列（`CUP` / `EXTRA_FUTON`）。
  cupsUsed: number;
  extraFutonUsed: number;
  /** 品目コード → 個数または使用の有無（§2.1）。 */
  amenitiesUsed: Record<string, number | boolean>;
  inputDurationMs: number | null;
  /** 記録者の `membership.id`。**連打の検出にのみ使う**（§5.3）。 */
  recordedById: string;
}

/** リネン記録 1 行（§2.3）。**回収枚数だけを使う。** */
export interface BaselineLinenInput {
  taskId: string;
  itemCode: string;
  collectedQty: number;
}

/** タスク 1 件。作業種別（集計キー）と未記録の印を持つ。 */
export interface BaselineTaskInput {
  taskId: string;
  roomId: string;
  businessDate: string;
  taskType: string;
  observationSkipped: boolean;
}

/** 客室 × 業務日の人数（`dailyRoomPlan`）。 */
export interface BaselineRoomPlanInput {
  roomId: string;
  businessDate: string;
  guestCount: number;
}

export interface BaselineSampleInput {
  observations: readonly BaselineObservationInput[];
  linenRecords: readonly BaselineLinenInput[];
  tasks: readonly BaselineTaskInput[];
  roomPlans: readonly BaselineRoomPlanInput[];
  /** `packages/contracts` の `ITEM_CODES`。**呼び出し側が渡す。** */
  itemCodes: readonly string[];
}

/** 平らにした結果。**捨てた件数を隠さない。** */
export interface BaselineSampleResult {
  samples: ObservationSample[];
  /** タスクが見つからず捨てた観察の件数。 */
  droppedNoTask: number;
  /** 稼働予定（人数）が無く捨てた観察の件数。 */
  droppedNoRoomPlan: number;
}

/** `roomId|businessDate`。 */
function planKeyOf(roomId: string, businessDate: string): string {
  return `${roomId}|${businessDate}`;
}

/**
 * アメニティの JSON の値を数に直す。
 *
 * **真偽値は「使った / 使っていない」で 1 / 0。** §2.1 の型が
 * `number | boolean` を許しており、施設によって歯ブラシを個数で数える所と
 * 有無だけを見る所がある。統計量は同じ尺度に載せる必要があるので、
 * 有無は 1 と 0 に寄せる（中央値 0.5 のような値を作らないため）。
 */
function toQty(value: number | boolean | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * 観察記録とリネン記録を `ObservationSample[]` へ平らにする。
 *
 * `hasFinding` は常に `false`。**P3 に差異は無い**（§0.2）。P4 が差異を
 * 持つようになったら、その task がここへ写像を足す。
 */
export function toObservationSamples(input: BaselineSampleInput): BaselineSampleResult {
  const vocabulary = new Set(input.itemCodes);

  const taskById = new Map<string, BaselineTaskInput>();
  for (const task of input.tasks) taskById.set(task.taskId, task);

  const guestCountByRoomDate = new Map<string, number>();
  for (const plan of input.roomPlans) {
    guestCountByRoomDate.set(planKeyOf(plan.roomId, plan.businessDate), plan.guestCount);
  }

  const linenByTask = new Map<string, BaselineLinenInput[]>();
  for (const record of input.linenRecords) {
    const bucket = linenByTask.get(record.taskId);
    if (bucket === undefined) linenByTask.set(record.taskId, [record]);
    else bucket.push(record);
  }

  const samples: ObservationSample[] = [];
  let droppedNoTask = 0;
  let droppedNoRoomPlan = 0;

  for (const observation of input.observations) {
    const task = taskById.get(observation.taskId);
    if (task === undefined) {
      droppedNoTask += 1;
      continue;
    }
    const guestCount = guestCountByRoomDate.get(
      planKeyOf(observation.roomId, observation.businessDate),
    );
    if (guestCount === undefined) {
      droppedNoRoomPlan += 1;
      continue;
    }

    // 同じ観察の中で品目が重複しないようにする（冒頭の優先順位）。
    const taken = new Set<string>();
    const push = (itemCode: string, qty: number): void => {
      if (!vocabulary.has(itemCode)) return;
      if (taken.has(itemCode)) return;
      taken.add(itemCode);
      samples.push({
        observationId: observation.observationId,
        propertyId: observation.propertyId,
        roomTypeId: observation.roomTypeId,
        guestCount,
        taskType: task.taskType,
        itemCode,
        qty,
        businessDate: observation.businessDate,
        recordedById: observation.recordedById,
        bedsUsed: observation.bedsUsed,
        inputDurationMs: observation.inputDurationMs,
        // P3 に差異は無い（§0.2）。
        hasFinding: false,
        observationSkipped: task.observationSkipped,
      });
    };

    // ① 列。
    for (const mapping of OBSERVATION_ITEM_COLUMNS) {
      push(mapping.itemCode, observation[mapping.column]);
    }
    // ② アメニティ（JSON）。**キーの順序に依存しない**ように整列してから積む。
    for (const itemCode of Object.keys(observation.amenitiesUsed).sort()) {
      const qty = toQty(observation.amenitiesUsed[itemCode]);
      if (qty !== null) push(itemCode, qty);
    }
    // ③ リネン記録。
    for (const record of linenByTask.get(observation.taskId) ?? []) {
      push(record.itemCode, record.collectedQty);
    }
  }

  return { samples, droppedNoTask, droppedNoRoomPlan };
}
