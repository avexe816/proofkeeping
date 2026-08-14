/**
 * ルール設定の組み立て（PK-SPEC-P4 §2.7 / W-25）。
 *
 * task: docs/tasks/P4-13.md
 *
 * ── 行が無いのが既定 ────────────────────────────────────
 * §2.7。設定されていないルールは「有効・上書きなし・閾値なし」で動く。
 * 一覧は**14 個すべてを返す**（設定の無いものも `isDefault: true` で並べる）。
 * 行がある／無いを画面に見せないと、「無効にしたつもりが保存されていない」
 * を確かめられない。
 *
 * ── engine に実体が無いルールも並べる ───────────────────
 * §3.1 は 14 個で閉じているが、実装済みは 10 個（OPEN_QUESTIONS #066）。
 * **`isImplemented: false` として出す。** 隠すと「設定したのに何も起きない」
 * 理由が画面から読めない。
 */

import type { RuleConfigSummary, RuleCodeValue } from "@pk/contracts";
import { RULE_CODES } from "@pk/contracts";
import { listRuleConfigs, type Env, type TenantContext } from "@pk/db";
import { findRule } from "@pk/engine";

/** `listRuleConfigs()` が返す行のうち、ここで要るもの。 */
type RuleConfigRow = Awaited<ReturnType<typeof listRuleConfigs>>[number];

/**
 * 施設 1 つぶんの設定一覧。
 *
 * **組織の既定と施設の行を畳んでから返す**（施設の行が勝つ / §2.7）。
 * どちらから来た値かは `hasPropertyOverride` で示す。
 */
export async function collectRuleConfigs(
  env: Env,
  ctx: TenantContext,
  propertyId: string,
): Promise<RuleConfigSummary[]> {
  const rows = await listRuleConfigs(env, ctx, propertyId);
  return RULE_CODES.map((ruleCode) => toSummary(ruleCode, rows, propertyId));
}

/** 1 ルールぶんを組み立てる。**設定が無ければ既定を返す。** */
export function toSummary(
  ruleCode: RuleCodeValue,
  rows: readonly RuleConfigRow[],
  propertyId: string,
): RuleConfigSummary {
  const rule = findRule(ruleCode);
  const forProperty = rows.find(
    (row) => row.ruleCode === ruleCode && row.propertyId === propertyId,
  );
  const forOrganization = rows.find(
    (row) => row.ruleCode === ruleCode && row.propertyId === null,
  );
  const effective = forProperty ?? forOrganization;

  return {
    ruleCode,
    // **`Rule.title` を唯一の出どころにする。** 名称を画面に写経すると、
    // engine 側の文言を変えたときに片方だけ残る。
    title: rule?.title ?? "",
    isImplemented: rule !== undefined,
    isEnabled: effective?.isEnabled ?? true,
    severityOverride: effective?.severityOverride ?? null,
    thresholds: effective?.thresholds ?? {},
    hasPropertyOverride: forProperty !== undefined,
    isDefault: effective === undefined,
  };
}
