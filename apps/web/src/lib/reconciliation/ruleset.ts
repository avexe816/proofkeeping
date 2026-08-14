/**
 * ルール設定の解決と指紋（PK-SPEC-P4 §2.4 / §2.7 / §5.3 の手順 4）。
 *
 * task: docs/tasks/P4-05.md
 *
 * ── 施設の設定が組織の既定に勝つ ────────────────────────
 * `ruleConfig.propertyId = null` が組織の既定、施設の行があればそちら
 * （§2.7）。**両方を渡してここで畳む。** リポジトリで畳むと、
 * 「施設に設定が無い」のか「既定と同じ値を明示した」のかが読めなくなる。
 *
 * ── 指紋を残す理由 ──────────────────────────────────────
 * `reconciliationRun.rulesetHash`（§2.4）。ある日から差異の件数が変わった
 * とき、**engine が変わったのか設定が変わったのか**を後から切り分けるため。
 * 暗号学的な強度は要らない（改竄の検出には使わない）ので、
 * シャード解決と同じ FNV-1a を使う。
 */

import { fnv1a32, type RuleCode } from "@pk/db";
import type { RuleSetting, Severity } from "@pk/engine";

/** `listRuleConfigs()` が返す行のうち、ここで要るもの。 */
export interface RuleConfigRow {
  propertyId: string | null;
  ruleCode: RuleCode;
  isEnabled: boolean;
  severityOverride: Severity | null;
  thresholds: Record<string, number>;
}

/**
 * 施設に効く設定を組み立てる。
 *
 * @param propertyId 施設。**`ruleConfig.propertyId` がこれと一致する行が勝つ。**
 * @returns ルールコード → 設定。設定の無いルールは**鍵ごと現れない**
 *   （`evaluate()` の既定＝有効・上書きなし・閾値なしが効く）。
 */
export function resolveRuleSettings(
  rows: readonly RuleConfigRow[],
  propertyId: string,
): Record<string, RuleSetting> {
  const settings: Record<string, RuleSetting> = {};

  // 組織の既定を先に敷き、施設の行で上書きする。**順番に意味がある。**
  for (const row of rows) {
    if (row.propertyId !== null) continue;
    settings[row.ruleCode] = toSetting(row);
  }
  for (const row of rows) {
    if (row.propertyId !== propertyId) continue;
    settings[row.ruleCode] = toSetting(row);
  }

  return settings;
}

function toSetting(row: RuleConfigRow): RuleSetting {
  return {
    isEnabled: row.isEnabled,
    severityOverride: row.severityOverride,
    thresholds: row.thresholds,
  };
}

/**
 * 適用した設定の指紋（§2.4 の `rulesetHash`）。
 *
 * **並びに依らない。** ルールコードで整列してから畳むので、DB の返す順が
 * 変わっても同じ設定なら同じ値になる（§10.1 の決定性）。閾値の鍵も
 * 整列する。値が同じなら 8 桁の 16 進が一致する。
 */
export function rulesetHashOf(settings: Readonly<Record<string, RuleSetting>>): string {
  const canonical = Object.keys(settings)
    .sort()
    .map((code) => {
      const setting = settings[code];
      if (setting === undefined) return code;
      const thresholds = Object.keys(setting.thresholds)
        .sort()
        .map((key) => `${key}=${String(setting.thresholds[key])}`)
        .join(",");
      return `${code}:${String(setting.isEnabled)}:${setting.severityOverride ?? "-"}:${thresholds}`;
    })
    .join("|");

  return fnv1a32(canonical).toString(16).padStart(8, "0");
}
