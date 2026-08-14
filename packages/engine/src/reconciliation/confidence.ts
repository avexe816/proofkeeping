/**
 * 確信度と重要度の調整（PK-SPEC-P4 §1.3 / §4.2）。**純粋関数。**
 *
 * task: docs/tasks/P4-03.md
 *
 * ── なぜルールの外に置くか ──────────────────────────────
 * §4.2 の調整は**全ルールに等しく掛かる**。各ルールの `evaluate()` の中で
 * 掛けると、14 個のうち 1 つだけ掛け忘れた形が生まれ、そのルールだけが
 * 高い確信度を出す。ルールは素の値を返し、調整はここが 1 か所で行う。
 *
 * ── 単一シグナルの上限 ──────────────────────────────────
 * §1.3 / P4 固有の絶対ルール「単一シグナルで confidence 80 以上を出さない」。
 * **1 つの根拠しか無い差異を「ほぼ確実」として見せない。** 現場に対して
 * 断定的に出た差異が外れると、それだけで信頼を失う（§11 のリスク）。
 */

import {
  MAX_CONFIDENCE,
  MIN_CONFIDENCE,
  SEVERITIES,
  type FindingDraft,
  type ObservationFact,
  type PropertyFact,
  type Severity,
} from "./types.js";

/**
 * 単一シグナルのときの上限。
 *
 * 「80 以上にならない」なので 79 まで。**80 にしないこと。**
 */
export const SINGLE_SIGNAL_CONFIDENCE_CAP = 79;

/** 既定値のまま確定した観察に基づく差異の調整（§4.2 / §10.4）。 */
export const USED_DEFAULTS_PENALTY = -20;

/** ベースラインのサンプル数が心もとないときの調整（§4.2）。 */
export const SMALL_SAMPLE_PENALTY = -10;

/** サンプル数がこの範囲なら `SMALL_SAMPLE_PENALTY`（§4.2 は「20〜40」）。 */
export const SMALL_SAMPLE_MIN = 20;
export const SMALL_SAMPLE_MAX = 40;

/** 運用開始からの日数がこれ未満なら調整（§4.2）。 */
export const NEW_OPERATION_DAYS = 60;

/** 運用が浅い施設の調整（§4.2）。 */
export const NEW_OPERATION_PENALTY = -10;

/** 直近 30 日にこの回数以上の誤検知があれば重要度を 1 段階下げる（§4.2）。 */
export const FALSE_POSITIVE_DOWNGRADE_THRESHOLD = 3;

/** 0〜100 に収める。 */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return MIN_CONFIDENCE;
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, Math.round(value)));
}

/** 確信度の調整に使う入力。 */
export interface ConfidenceInputs {
  observation: ObservationFact | null;
  property: PropertyFact;
  /** 根拠に使ったベースラインのサンプル数。使っていなければ `null`。 */
  baselineSampleSize: number | null;
}

/**
 * §4.2 の調整を掛ける。
 *
 * **調整は足し合わせる。** 既定値の観察かつ運用が浅い施設なら −30。
 * 仕様は「どれか 1 つだけ」とは書いておらず、条件はそれぞれ独立に
 * 確信度を下げる理由になっている。
 */
export function adjustConfidence(base: number, inputs: ConfidenceInputs): number {
  let value = base;

  if (inputs.observation?.usedDefaults === true) value += USED_DEFAULTS_PENALTY;

  if (
    inputs.baselineSampleSize !== null &&
    inputs.baselineSampleSize >= SMALL_SAMPLE_MIN &&
    inputs.baselineSampleSize <= SMALL_SAMPLE_MAX
  ) {
    value += SMALL_SAMPLE_PENALTY;
  }

  const operationDays = inputs.property.daysSinceOperationStart;
  if (operationDays !== null && operationDays < NEW_OPERATION_DAYS) {
    value += NEW_OPERATION_PENALTY;
  }

  return clampConfidence(value);
}

/**
 * 単一シグナルの上限を掛ける（§1.3）。
 *
 * **根拠が 0 件のときも単一扱い。** 根拠を 1 つも出せない差異を
 * 高い確信度で出さない。
 */
export function capSingleSignal(confidence: number, matchedSignalCount: number): number {
  if (matchedSignalCount > 1) return clampConfidence(confidence);
  return Math.min(clampConfidence(confidence), SINGLE_SIGNAL_CONFIDENCE_CAP);
}

/** 重要度を 1 段階下げる。`LOW` はそれ以上下がらない。 */
export function downgradeSeverity(severity: Severity): Severity {
  const index = SEVERITIES.indexOf(severity);
  return SEVERITIES[Math.min(index + 1, SEVERITIES.length - 1)] ?? severity;
}

/**
 * 差異 1 件に §1.3 / §4.2 を適用する。
 *
 * @param falsePositiveCount 同一客室・同一ルールで直近 30 日の誤検知件数（§4.2）。
 * @param severityOverride `ruleConfig.severityOverride`。**引き下げより先に効く。**
 *   施設ごとの設定は「このルールはうちでは HIGH で扱う」という運用の宣言で、
 *   誤検知の学習はその上に乗る調整。
 */
export function applyAdjustments(
  draft: FindingDraft,
  inputs: ConfidenceInputs & {
    falsePositiveCount: number;
    severityOverride: Severity | null;
  },
): FindingDraft {
  const confidence = capSingleSignal(
    adjustConfidence(draft.confidence, inputs),
    draft.matchedSignals.length,
  );

  let severity = inputs.severityOverride ?? draft.severity;
  if (inputs.falsePositiveCount >= FALSE_POSITIVE_DOWNGRADE_THRESHOLD) {
    severity = downgradeSeverity(severity);
  }

  return { ...draft, confidence, severity };
}
