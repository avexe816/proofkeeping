/**
 * 検出ルールのレジストリ（PK-SPEC-P4 §9）。
 *
 * task: docs/tasks/P4-03.md
 *
 * ── ルールを 1 つ足す手順 ───────────────────────────────
 * ① `rules/R0NN.ts` に `Rule` を 1 つ書く（純粋関数）
 * ② 下の `RULES` に import して 1 行足す
 *
 * **これ以外に触る場所を作らないこと**（P4-03 の完了条件
 * 「ルールの追加が registry への登録だけで済む」）。`evaluate()` は
 * この並びを順に回すだけで、ルールごとの分岐を持たない。
 *
 * ── まだ空 ──────────────────────────────────────────────
 * P4-03 は骨格を作る task。**R001 / R006 は P4-04 が足す**（§実装順序 4）。
 * 実装順序が「まず 2 つだけ → 実データで検証 → 誤検知率を確認してから
 * 残り」となっているのは、14 個を先に書くと誤検知の原因を切り分けられなく
 * なるため。**ここへ先回りしてルールを足さないこと。**
 */

import type { Rule } from "../types.js";

/**
 * 有効なルールの並び。**評価はこの順。**
 *
 * §3.1 の一覧（R001〜R014）のうち、実装済みのものだけがここに載る。
 * 載っていないコードは `ruleConfig` に設定があっても動かない。
 */
export const RULES: readonly Rule[] = [];

/** コード → ルール。**同じコードを 2 度登録していないことを起動時に落とす。** */
const BY_CODE: ReadonlyMap<string, Rule> = (() => {
  const map = new Map<string, Rule>();
  for (const rule of RULES) {
    if (map.has(rule.code)) throw new Error(`DUPLICATE_RULE_CODE:${rule.code}`);
    map.set(rule.code, rule);
  }
  return map;
})();

/** 1 つ引く。未実装のコードは `undefined`。 */
export function findRule(code: string): Rule | undefined {
  return BY_CODE.get(code);
}

/** 実装済みのルールコード。**`ruleConfig` の画面が「設定できる対象」を出すのに使う。** */
export function implementedRuleCodes(): string[] {
  return RULES.map((rule) => rule.code);
}
