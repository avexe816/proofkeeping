/**
 * 料金の解決（PK-SPEC-P5 §3.2 / billing.md §8）。**純粋関数。**
 *
 * task:  docs/tasks/P5-03.md
 * ルール: .claude/rules/billing.md §8
 *
 * ── 5 段階の優先順位 ────────────────────────────────────
 * ```
 * 1. propertyId + roomTypeId + taskType が一致
 * 2. propertyId + taskType が一致
 * 3. propertyId が一致
 * 4. taskType が一致
 * 5. 取引先の既定
 * ```
 * **具体的なものが先。** 同じ段の中で複数当たったら `priority` の
 * **小さい**ものを採る（§3.2 が明記。直感と逆に見えるが仕様どおり）。
 *
 * ── 黙って落とさない（§3.2 MUST / billing.md §8）─────────
 * 該当が無いタスクを請求から**除外しない。** `resolveUnitPrice()` は
 * `null` を返し、呼び出し側が `unitPrice = 0` の明細として計上して
 * 警告を出す（`aggregate.ts` の `unpricedGroups`）。
 * **ここで既定単価を捏造しないこと。** 0 円と「値段が決まっていない」は
 * 別で、後者は人が直すまで残さないといけない。
 *
 * ── DB・fetch・現在時刻を持ち込まない ───────────────────
 * CLAUDE.md §5。有効期間の判定に使う日付は**引数で受け取る**
 * （`Date.now()` を呼ばない）。
 */

/** 料金設定 1 件（`pricingRule` のうち解決に要る部分）。 */
export interface PricingRuleFact {
  id: string;
  /** null = 取引先の全施設。 */
  propertyId: string | null;
  /** null = 全客室タイプ。 */
  roomTypeId: string | null;
  /** null = 全作業種別。 */
  taskType: string | null;
  itemCode: string;
  /** 円（税抜）。**整数。** */
  unitPrice: number;
  /** 百分率の整数（10 / 8）。 */
  taxRate: number;
  isReducedRate: boolean;
  /** `YYYY-MM-DD`。 */
  validFrom: string;
  validTo: string | null;
  /** **小さいほうが勝つ**（§3.2）。 */
  priority: number;
}

/** 料金を引く鍵。**すべて分かっている前提で渡す。** */
export interface PricingKey {
  propertyId: string;
  roomTypeId: string | null;
  taskType: string;
  itemCode: string;
  /** 役務提供日（`YYYY-MM-DD`）。有効期間の判定に使う。 */
  serviceDate: string;
}

/**
 * 5 段階の具体度（§3.2）。**この並びが優先順位そのもの。**
 *
 * 添字が小さいほど具体的。`matchStage()` が返す値をそのまま比較に使う。
 */
export const PRICING_STAGES = [
  "PROPERTY_ROOM_TYPE_TASK",
  "PROPERTY_TASK",
  "PROPERTY",
  "TASK",
  "COUNTERPARTY_DEFAULT",
] as const;

export type PricingStage = (typeof PRICING_STAGES)[number];

/** 有効期間内か（両端を含む）。**業務日は text なので辞書順で比べる。** */
export function isEffective(rule: PricingRuleFact, serviceDate: string): boolean {
  if (rule.validFrom > serviceDate) return false;
  if (rule.validTo !== null && rule.validTo < serviceDate) return false;
  return true;
}

/**
 * その規則が鍵に当たる段（§3.2）。当たらなければ `null`。
 *
 * ── 「一致」と「問わない」を取り違えない ────────────────
 * 規則の `propertyId` が `null` なら**どの施設にも当たる**（全施設向け）。
 * 施設が指定されていて鍵と違うなら当たらない。同じことが
 * `roomTypeId` / `taskType` にも言える。
 */
export function matchStage(rule: PricingRuleFact, key: PricingKey): PricingStage | null {
  if (rule.itemCode !== key.itemCode) return null;

  // 施設・客室タイプ・作業種別のそれぞれについて、「指定があって違う」なら外れる。
  if (rule.propertyId !== null && rule.propertyId !== key.propertyId) return null;
  if (rule.roomTypeId !== null && rule.roomTypeId !== key.roomTypeId) return null;
  if (rule.taskType !== null && rule.taskType !== key.taskType) return null;

  const hasProperty = rule.propertyId !== null;
  const hasRoomType = rule.roomTypeId !== null;
  const hasTaskType = rule.taskType !== null;

  if (hasProperty && hasRoomType && hasTaskType) return "PROPERTY_ROOM_TYPE_TASK";
  if (hasProperty && hasTaskType) return "PROPERTY_TASK";
  if (hasProperty) return "PROPERTY";
  if (hasTaskType) return "TASK";
  // 施設も作業種別も問わない行 = 取引先の既定。
  // **`roomTypeId` だけを持つ行もここに落ちる。** §3.2 の 5 段階に
  // 「客室タイプだけ」の段が無いため（仕様どおり。段を勝手に増やさない）。
  return "COUNTERPARTY_DEFAULT";
}

/** 解決の結果。**どの段で当たったかを返す**（画面と監査で根拠になる）。 */
export interface ResolvedPricing {
  rule: PricingRuleFact;
  stage: PricingStage;
}

/**
 * 料金を 1 つ選ぶ（§3.2）。
 *
 * **決定性がある。** 具体度 → `priority`（小さい順）→ `validFrom`（新しい順）
 * → `id` で決着させるので、同じ入力からは必ず同じ規則が出る。
 * 最後に `id` を入れてあるのは、すべて同点のときに並び順へ依存しないため。
 *
 * @returns 該当が無ければ `null`。**既定単価を作らない**（冒頭の注記）。
 */
export function resolvePricing(
  rules: readonly PricingRuleFact[],
  key: PricingKey,
): ResolvedPricing | null {
  const candidates: ResolvedPricing[] = [];
  for (const rule of rules) {
    if (!isEffective(rule, key.serviceDate)) continue;
    const stage = matchStage(rule, key);
    if (stage === null) continue;
    candidates.push({ rule, stage });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const byStage = PRICING_STAGES.indexOf(a.stage) - PRICING_STAGES.indexOf(b.stage);
    if (byStage !== 0) return byStage;
    // **小さいほうが勝つ**（§3.2）。
    if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority;
    // 同点なら新しく始まった規則を採る（値上げの適用漏れを避ける）。
    if (a.rule.validFrom !== b.rule.validFrom) return a.rule.validFrom < b.rule.validFrom ? 1 : -1;
    return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
  });

  return candidates[0] ?? null;
}

/**
 * 単価だけが要るとき（§3.2）。
 *
 * @returns 該当が無ければ `null`。**0 を返さない。**
 *   0 円は「無料と決めた」で、`null` は「値段が決まっていない」。
 *   混ぜると、決め忘れが請求書に 0 円として静かに載る。
 */
export function resolveUnitPrice(
  rules: readonly PricingRuleFact[],
  key: PricingKey,
): number | null {
  return resolvePricing(rules, key)?.rule.unitPrice ?? null;
}
