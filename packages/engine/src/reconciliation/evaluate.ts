/**
 * 稼働照合の入口（PK-SPEC-P4 §9）。**純粋関数。**
 *
 * task: docs/tasks/P4-03.md
 *
 * ```
 * evaluate(context) -> { findings, suppressed, rulesEvaluated }
 * ```
 *
 * ── 順番 ────────────────────────────────────────────────
 * §5.3 の処理フロー 4〜6 に対応する。
 *
 *   ① ruleConfig を適用してルールセットを構築
 *   ② 抑制の判定（§4.1）→ 抑えたものは `evaluate()` を呼ばない
 *   ③ 各ルールを評価
 *   ④ §1.3 / §4.2 の調整を掛ける
 *
 * **調整を最後にまとめて掛ける**理由は `confidence.ts` の冒頭に書いた。
 *
 * ── 決定性 ──────────────────────────────────────────────
 * §10.1「同じ入力から同じ出力が得られる」。`Date.now()` を呼ばず、
 * 並びの順序を変えず、`Math.random()` を使わない。この 3 つが崩れると
 * §10.2 の「3 回実行しても Finding が重複しない」が成り立たなくなる。
 *
 * ── R001 と R002 の統合はここではない ───────────────────
 * §3.3 MUST は「R001 と R002 が同一客室・同一業務日で同時に発生したら
 * R002 に統合する」と定める。**R002 を実装する task（P4-11）が行う。**
 * 片方しか無い今の段階で統合の枝を書くと、検証できない分岐が残る。
 */

import { applyAdjustments } from "./confidence.js";
import { RULES } from "./rules/registry.js";
import { availableSourcesOf, suppressionReasonOf } from "./suppression.js";
import type {
  EvaluationOptions,
  EvaluationResult,
  FindingDraft,
  Rule,
  RuleContext,
  RuleSetting,
  SuppressedRule,
} from "./types.js";

/** 設定が無いルールの既定。**有効・上書きなし・閾値なし。** */
const DEFAULT_SETTING: RuleSetting = {
  isEnabled: true,
  severityOverride: null,
  thresholds: {},
};

/**
 * 根拠に使ったベースラインのサンプル数（§4.2 の −10 の判定用）。
 *
 * **最小のサンプル数を採る。** 複数の品目を根拠にした差異では、
 * 一番心もとない統計に合わせて確信度を下げるのが安全側。
 */
function baselineSampleSizeOf(context: RuleContext, draft: FindingDraft): number | null {
  const used = context.baselines.filter((baseline) =>
    draft.matchedSignals.some((signal) => signal.includes(baseline.itemCode)),
  );
  if (used.length === 0) return null;
  return Math.min(...used.map((baseline) => baseline.sampleSize));
}

/**
 * 1 客室ぶんを照合する。
 *
 * @param context その客室の 3 系統の事実。**`now` は呼び出し側が注入する。**
 * @param options `ruleConfig` と誤検知の履歴。省略すると既定。
 * @param rules 評価するルール。**省略時はレジストリの全件。**
 *   差し替えられるのはテストのためで、本番の呼び出しは省略する。
 */
export function evaluate(
  context: RuleContext,
  options: EvaluationOptions = {},
  rules: readonly Rule[] = RULES,
): EvaluationResult {
  const availableSources =
    options.availableSources ??
    availableSourcesOf({
      occupancy: context.occupancy,
      observation: context.observation,
      signals: context.signals,
    });

  const findings: FindingDraft[] = [];
  const suppressed: SuppressedRule[] = [];
  let rulesEvaluated = 0;

  for (const rule of rules) {
    const setting = options.settings?.[rule.code];

    const reason = suppressionReasonOf(rule, {
      property: context.property,
      room: context.room,
      occupancy: context.occupancy,
      accessLogs: context.accessLogs,
      availableSources,
      setting,
    });
    if (reason !== null) {
      suppressed.push({ ruleCode: rule.code, reason });
      continue;
    }

    rulesEvaluated += 1;

    // ルールごとの閾値を渡す。**engine が知らない鍵は各ルールが無視する。**
    const draft = rule.evaluate({
      ...context,
      thresholds: setting?.thresholds ?? DEFAULT_SETTING.thresholds,
    });
    if (draft === null) continue;

    findings.push(
      applyAdjustments(draft, {
        observation: context.observation,
        property: context.property,
        baselineSampleSize: baselineSampleSizeOf(context, draft),
        falsePositiveCount: options.falsePositiveCounts?.[rule.code] ?? 0,
        severityOverride: setting?.severityOverride ?? null,
      }),
    );
  }

  return { findings, suppressed, rulesEvaluated };
}
