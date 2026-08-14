/**
 * 料金の解決（PK-SPEC-P5 §3.2 / .claude/rules/billing.md §8）。
 *
 * task: docs/tasks/P5-03.md
 *
 * ── 5 段階の梯子 ────────────────────────────────────────
 * ```
 * 1. propertyId + roomTypeId + taskType が一致
 * 2. propertyId + taskType が一致
 * 3. propertyId が一致
 * 4. taskType が一致
 * 5. 取引先の既定
 * ```
 * **段が上（数字が小さい）ほど勝つ。** 同じ段に複数あれば
 * `priority` の**小さい**ものを採用する（§3.2 の本文どおり）。
 *
 * ── `priority` の向きが schema のコメントと逆だった ──────
 * `packages/db/src/schema/invoice.ts` の `pricingRule.priority` には
 * 「大きいほうが勝つ」と書いてあったが、仕様（§3.2）は「小さいものを
 * 採用」。**仕様が唯一の正**（CLAUDE.md §7）なので小さいほうを採り、
 * schema のコメントと `listPricingRules()` の並び順を直した。
 * docs/DECISIONS.md #122。
 *
 * ── 梯子に載らない形の行は「勝てない」──────────────────
 * §3.2 の 5 段はすべて「客室タイプを見るなら作業種別も見る」形で、
 * たとえば `propertyId + roomTypeId`（作業種別が null）に当たる段が無い。
 * この形の行はどの段にも属さず、**永遠に選ばれない。**
 * 黙って死ぬ設定を作らせないため、`pricingRuleStage()` が `null` を返し、
 * P5-03 の登録 API がその形を 400 で断る。docs/DECISIONS.md #123。
 *
 * ── この module は純粋 ──────────────────────────────────
 * DB・fetch・環境変数・`Date.now()` を持ち込まない（CLAUDE.md §5）。
 * 「今日」は `on`（`YYYY-MM-DD`）で受け取る。
 */

import type { InvoiceItemCodeValue } from "./vocabulary.js";

/**
 * 解決の入力になる料金設定 1 行。
 *
 * `pricingRule` 表（§2.2）の部分集合。**`counterpartyId` を含めない。**
 * 取引先で絞るのは DB 側（`listPricingRules({ counterpartyId })`）の仕事で、
 * ここへ持ち込むと「絞ったつもりで絞れていない」経路が 2 本になる。
 */
export interface PricingRuleCandidate {
  id: string;
  /** null = 取引先の全施設。 */
  propertyId: string | null;
  /** null = 全客室タイプ。 */
  roomTypeId: string | null;
  /** null = 全作業種別。 */
  taskType: string | null;
  itemCode: InvoiceItemCodeValue;
  /** 円（税抜）。整数（billing.md §4）。 */
  unitPrice: number;
  /** 百分率の整数（10 / 8）。 */
  taxRate: number;
  isReducedRate: boolean;
  /** `YYYY-MM-DD`。 */
  validFrom: string;
  /** `YYYY-MM-DD`。null = 無期限。 */
  validTo: string | null;
  /** 同じ段で競合したときの順位。**小さいほうが勝つ**（§3.2）。 */
  priority: number;
}

/** 「この条件の作業がいくらか」を尋ねる側。 */
export interface PricingQuery {
  itemCode: InvoiceItemCodeValue;
  propertyId: string;
  /** 客室タイプを持たない作業（共用部）は null。 */
  roomTypeId: string | null;
  taskType: string;
  /** 役務提供日（業務日 `YYYY-MM-DD`）。有効期間の判定に使う。 */
  on: string;
}

/** 解決の段（1〜5）。小さいほど具体的で、優先される。 */
export type PricingStage = 1 | 2 | 3 | 4 | 5;

/**
 * §3.2 の 5 段。**行の「どの列が null か」だけで段が決まる。**
 *
 * 照合そのもの（値が一致するか）は `matchesQuery()` が見る。
 * 段の判定と一致の判定を混ぜると、「一致しなかった」のか
 * 「そもそも梯子に載っていない」のかが読めなくなる。
 */
const RULE_SHAPES: readonly {
  stage: PricingStage;
  hasProperty: boolean;
  hasRoomType: boolean;
  hasTaskType: boolean;
}[] = [
  { stage: 1, hasProperty: true, hasRoomType: true, hasTaskType: true },
  { stage: 2, hasProperty: true, hasRoomType: false, hasTaskType: true },
  { stage: 3, hasProperty: true, hasRoomType: false, hasTaskType: false },
  { stage: 4, hasProperty: false, hasRoomType: false, hasTaskType: true },
  { stage: 5, hasProperty: false, hasRoomType: false, hasTaskType: false },
];

/**
 * その行が §3.2 のどの段に属するか。**属さないなら `null`。**
 *
 * `null` が返る形（例: 施設 + 客室タイプ、客室タイプのみ）は、
 * 登録できても選ばれない。呼び出し側は登録の時点で断ること。
 */
export function pricingRuleStage(
  rule: Pick<PricingRuleCandidate, "propertyId" | "roomTypeId" | "taskType">,
): PricingStage | null {
  const shape = RULE_SHAPES.find(
    (s) =>
      s.hasProperty === (rule.propertyId !== null) &&
      s.hasRoomType === (rule.roomTypeId !== null) &&
      s.hasTaskType === (rule.taskType !== null),
  );
  return shape === undefined ? null : shape.stage;
}

/**
 * 有効期間の判定（§3.2「validFrom / validTo で有効期間を判定する」）。
 *
 * **両端を含む。** `validTo` の当日はまだ有効。`YYYY-MM-DD` は
 * 辞書順と時系列順が一致するので、文字列比較でよい（architecture.md §7 が
 * この形で保存すると定めている理由のひとつ）。
 */
export function isEffectiveOn(
  rule: Pick<PricingRuleCandidate, "validFrom" | "validTo">,
  on: string,
): boolean {
  if (on < rule.validFrom) return false;
  return rule.validTo === null || on <= rule.validTo;
}

/** 行の非 null の列が、尋ねられた条件と一致するか。 */
function matchesQuery(rule: PricingRuleCandidate, query: PricingQuery): boolean {
  if (rule.itemCode !== query.itemCode) return false;
  if (rule.propertyId !== null && rule.propertyId !== query.propertyId) return false;
  if (rule.roomTypeId !== null && rule.roomTypeId !== query.roomTypeId) return false;
  if (rule.taskType !== null && rule.taskType !== query.taskType) return false;
  return true;
}

/** `resolvePricingRule()` の結果。**採った段を返す**（画面が根拠を示せる）。 */
export interface PricingResolution {
  rule: PricingRuleCandidate;
  stage: PricingStage;
}

/**
 * 5 段階で料金設定を 1 件に決める。**該当が無ければ `null`。**
 *
 * `null` を「請求しない」と読み替えないこと。§3.2 MUST は
 * 「該当する料金設定がないタスクは請求から除外せず、`unitPrice = 0` の
 * 明細として計上し、画面に警告を出す」と定める。その扱いは
 * `buildInvoiceDraft()`（P5-04）が行う。
 *
 * @param rules 1 取引先ぶんの料金設定。**取引先での絞り込みは呼び出し側。**
 */
export function resolvePricingRule(
  rules: readonly PricingRuleCandidate[],
  query: PricingQuery,
): PricingResolution | null {
  let best: PricingResolution | null = null;

  for (const rule of rules) {
    const stage = pricingRuleStage(rule);
    if (stage === null) continue;
    if (!isEffectiveOn(rule, query.on)) continue;
    if (!matchesQuery(rule, query)) continue;
    if (best === null || isStronger({ rule, stage }, best)) best = { rule, stage };
  }

  return best;
}

/**
 * どちらを採るか。**段 → `priority` → `validFrom` → `id` の順に見る。**
 *
 * 仕様が決めているのは段と `priority` の 2 つだけ。残り 2 つは
 * **同じ入力から同じ結果を出すため**に置いてある。ここが揺れると、
 * 同じ月を 2 回集計したときに金額が変わりうる（testing.md §4 の冪等性）。
 * 期間が新しいほうを先に見るのは、値上げが行の追加で表されるため
 * （§2.2 の注記）。
 */
function isStronger(a: PricingResolution, b: PricingResolution): boolean {
  if (a.stage !== b.stage) return a.stage < b.stage;
  if (a.rule.priority !== b.rule.priority) return a.rule.priority < b.rule.priority;
  if (a.rule.validFrom !== b.rule.validFrom) return a.rule.validFrom > b.rule.validFrom;
  return a.rule.id < b.rule.id;
}
