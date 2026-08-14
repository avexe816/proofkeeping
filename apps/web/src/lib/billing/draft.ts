/**
 * 締めの明細を組み立てる（PK-SPEC-P5 §3・§6）。
 *
 * task: docs/tasks/P5-12.md（P5-07 の `issue.ts` から切り出した）
 *
 * ── 発行と合意が同じ計算を通る ──────────────────────────
 * §0.2 の出荷判定は「清掃会社とホテルが**同じ明細を見て**相違なく
 * 合意できる」。合意の画面（§6.2）と請求書の発行（§4.1）が別々に明細を
 * 組み立てると、**見て合意した数字と、送られた請求書の数字が違う**という
 * 事故がいつでも起こりうる。組み立てはここ 1 か所に置く。
 *
 * ── ここは純粋関数ではない ──────────────────────────────
 * DB を引く（タスク・施設・客室・料金設定）。計算そのものは
 * `@pk/billing` の `buildInvoiceDraft()`（依存ゼロ / CLAUDE.md §5）で、
 * この module がやるのは**入力を集めること**だけ。金額の判断を
 * ここへ書かない。
 */

import {
  buildInvoiceDraft,
  counterpartyPropertyScope,
  type BillableTask,
  type InvoiceDraft,
  type TaxRoundingModeValue,
} from "@pk/billing";
import {
  listPricingRules,
  listProperties,
  listRoomTypes,
  listRooms,
  listTasks,
  type Env,
  type TenantContext,
} from "@pk/db";

/**
 * 締めの期間に含まれる清掃タスクを集める（§3.1）。
 *
 * **施設の範囲は料金設定から導く**（`counterpartyPropertyScope()` /
 * OPEN_QUESTIONS #071）。除外の判断（`COMPLETED` 以外）は
 * `buildInvoiceDraft()` の中。ここでは絞らずに渡す。
 *
 * ── 客室タイプはタスクに載っていない ────────────────────
 * `cleaningTask` は `roomId` しか持たない（客室タイプは `room` 側）。
 * §3.4 の粒度（施設 × 清掃種別 × 客室タイプ）で畳むために、施設ごとに
 * 客室と客室タイプを 1 回ずつ引いて対応表を作る。**タスク 1 件ごとに
 * 引かない**（明細 300 件で 300 往復になる）。
 *
 * ── `isRework` は常に偽 ─────────────────────────────────
 * 再清掃は**同じタスクに対する巡回**（`reworkCycle` は `taskId` + `round`）で、
 * 別のタスクにはならない。つまり「再清掃のタスク」は存在しない。
 * §3.1 の「再清掃（ReworkCycle）※ 有償設定の場合のみ計上」を満たすには
 * `reworkCycle` を独立の明細（`REWORK` 品目）として起こす必要があるが、
 * その可否を決める**有償設定の列がまだ無い**（docs/OPEN_QUESTIONS.md #070）。
 * 列ができるまで計上しない。**黙って落としているのではなく、
 * 起こす対象がまだ定義されていない。**
 */
async function collectBillableTasks(
  env: Env,
  ctx: TenantContext,
  input: { propertyIds: readonly string[]; periodFrom: string; periodTo: string },
): Promise<BillableTask[]> {
  const properties = await listProperties(env, ctx, { isActive: true });
  const nameById = new Map(properties.map((property) => [property.id, property.name]));

  const tasks: BillableTask[] = [];
  for (const propertyId of input.propertyIds) {
    const [rows, rooms, roomTypes] = await Promise.all([
      listTasks(env, ctx, {
        propertyId,
        businessDateFrom: input.periodFrom,
        businessDateTo: input.periodTo,
      }),
      listRooms(env, ctx, { propertyId }),
      listRoomTypes(env, ctx, propertyId, {}),
    ]);

    const roomTypeIdByRoomId = new Map(rooms.map((room) => [room.id, room.roomTypeId]));
    const roomTypeNameById = new Map(roomTypes.map((roomType) => [roomType.id, roomType.name]));

    for (const row of rows) {
      const roomTypeId = roomTypeIdByRoomId.get(row.roomId) ?? null;
      tasks.push({
        taskId: row.id,
        propertyId: row.propertyId,
        propertyName: nameById.get(row.propertyId) ?? row.propertyId,
        roomTypeId,
        roomTypeName: roomTypeId === null ? null : (roomTypeNameById.get(roomTypeId) ?? null),
        taskType: row.taskType,
        businessDate: row.businessDate,
        status: row.status,
        isRework: false,
      });
    }
  }
  return tasks;
}

export interface BuildPeriodDraftInput {
  counterpartyId: string;
  periodFrom: string;
  periodTo: string;
  /** 取引先の端数処理方式（`counterparty.taxRoundingMode` / §3.3）。 */
  taxRoundingMode: TaxRoundingModeValue;
  /** 再清掃を計上するか（OPEN_QUESTIONS #070）。既定は `false`。 */
  chargeRework?: boolean;
}

/**
 * 1 期間ぶんの明細ドラフト。**採番も INSERT もしない。**
 *
 * 何度呼んでも同じ結果になる（`buildInvoiceDraft()` が冪等 /
 * testing.md §4）。ただし**元データが変われば結果は変わる。** 合意した
 * ときの数字は履歴（`billingPeriodReview.linesSnapshot`）に残す。
 */
export async function buildPeriodDraft(
  env: Env,
  ctx: TenantContext,
  input: BuildPeriodDraftInput,
): Promise<InvoiceDraft> {
  const pricingRules = await listPricingRules(env, ctx, {
    counterpartyId: input.counterpartyId,
  });
  const scope = counterpartyPropertyScope(pricingRules);
  const propertyIds =
    scope.kind === "ALL_PROPERTIES"
      ? (await listProperties(env, ctx, { isActive: true })).map((property) => property.id)
      : scope.propertyIds;

  const tasks = await collectBillableTasks(env, ctx, {
    propertyIds,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
  });

  return buildInvoiceDraft({
    tasks,
    pricingRules,
    taxRoundingMode: input.taxRoundingMode,
    chargeRework: input.chargeRework ?? false,
  });
}
