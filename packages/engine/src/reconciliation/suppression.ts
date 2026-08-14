/**
 * 抑制（PK-SPEC-P4 §4.1）。**純粋関数。**
 *
 * task: docs/tasks/P4-03.md
 *
 * ── 沈黙させない ────────────────────────────────────────
 * §4.3 MUST。抑制した差異は**件数と理由を返す。** `null` を返して黙って
 * 消すのではなく、「何を・なぜ抑えたか」を呼び出し側へ渡し、
 * `reconciliationRun.findingsSuppressed` と管理画面に出す。
 *
 * ── 抑制はルールの前に効く ──────────────────────────────
 * 抑制されたルールは `evaluate()` を呼ばない。呼んでから捨てると、
 * 「差異が出たが抑えた」のか「そもそも該当しなかった」のかが混ざり、
 * §4.3 の件数が意味を失う。
 */

import type {
  AccessLogFact,
  OccupancyFact,
  PropertyFact,
  ReconciliationSource,
  RoomFact,
  Rule,
  RuleSetting,
  SuppressionReason,
} from "./types.js";

/** 開業・導入からこの日数以内はベースラインを要るルールを抑制する（§4.1）。 */
export const NEW_PROPERTY_SUPPRESSION_DAYS = 30;

/** 販売していない客室の状態（§4.1）。**清掃も稼働も通常の意味を持たない。** */
const NOT_ON_SALE: ReadonlySet<RoomFact["saleStatus"]> = new Set<RoomFact["saleStatus"]>([
  "MAINTENANCE",
  "OUT_OF_ORDER",
]);

/** 抑制の判定に渡す事実。 */
export interface SuppressionInputs {
  property: PropertyFact;
  room: RoomFact;
  occupancy: OccupancyFact | null;
  accessLogs: readonly AccessLogFact[];
  availableSources: readonly ReconciliationSource[];
  setting: RuleSetting | undefined;
}

/**
 * このルールを抑制するか。抑制するなら理由、しないなら `null`。
 *
 * **順番に意味がある。** 先に当たった理由を返すので、より根本的な条件
 * （設定で無効・系統が無い）を前に置く。「客室が MAINTENANCE だから」より
 * 「そもそもルールが無効だから」のほうが、運用として先に説明したい理由。
 */
export function suppressionReasonOf(
  rule: Rule,
  inputs: SuppressionInputs,
): SuppressionReason | null {
  // ① ruleConfig.isEnabled = false
  if (inputs.setting?.isEnabled === false) return "RULE_DISABLED";

  // ② 要る系統が揃っていない（§1.2）。**「A のみ」で何も検出しないのはここ。**
  const available = new Set(inputs.availableSources);
  if (rule.requires.some((source) => !available.has(source))) return "SOURCE_UNAVAILABLE";

  // ③ 施設が稼働記録の連携を持たない（A 系統を要するルール）。
  //    **`occupancyLinked` の列はまだ無い**（OPEN_QUESTIONS #063）。
  if (rule.requires.includes("occupancy") && !inputs.property.occupancyLinked) {
    return "OCCUPANCY_NOT_LINKED";
  }

  // ④ 開業・導入から 30 日以内（ベースラインが未成熟なルール）。
  const operationDays = inputs.property.daysSinceOperationStart;
  if (
    rule.requiresBaseline === true &&
    operationDays !== null &&
    operationDays < NEW_PROPERTY_SUPPRESSION_DAYS
  ) {
    return "OPERATION_TOO_NEW";
  }

  // ⑤ 客室が MAINTENANCE / OUT_OF_ORDER
  if (NOT_ON_SALE.has(inputs.room.saleStatus)) return "ROOM_NOT_ON_SALE";

  // ⑥ 自社利用・招待
  if (inputs.occupancy?.isHouseUse === true || inputs.occupancy?.isComplimentary === true) {
    return "HOUSE_USE_OR_COMPLIMENTARY";
  }

  // ⑦ 正当な入室が登録済み。
  //    **その業務日に 1 件でもあれば抑える**（§3.2 の R001 が
  //    `accessLogs.length > 0` で判定しているのと同じ粒度）。時間帯での
  //    絞り込みは、差異に時刻の幅を持たせるルールが出てから決める。
  if (inputs.accessLogs.length > 0) return "ACCESS_LOG_REGISTERED";

  return null;
}

/**
 * 揃っている系統を事実から判定する（§1.2）。
 *
 * **観察をスキップした場合も「観察系統はある」とみなす。** 「今回は記録
 * しない」は現場が選べる正当な操作（PK-SPEC-P3 §1.3）で、系統の欠落ではない。
 * スキップを差異にしないのは各ルールの責務（`observation.skipped` を見る）。
 */
export function availableSourcesOf(inputs: {
  occupancy: OccupancyFact | null;
  observation: object | null;
  signals: readonly unknown[];
}): ReconciliationSource[] {
  const sources: ReconciliationSource[] = [];
  if (inputs.occupancy !== null) sources.push("occupancy");
  if (inputs.observation !== null) sources.push("observation");
  if (inputs.signals.length > 0) sources.push("signal");
  return sources;
}
