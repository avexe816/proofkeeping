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
 * ── いまは 2 つ ─────────────────────────────────────────
 * P4-04 が R001 / R006 を足した（§実装順序 4）。**残り 12 個をここへ
 * 先回りして足さないこと。** 実装順序が「まず 2 つだけ → 実データで検証
 * → 誤検知率を確認してから残り」となっているのは、14 個を先に書くと
 * 誤検知の原因を切り分けられなくなるため。R003 / R004 / R005 は P4-08
 * （誤検知率の検証・人間が実施）を通してから P4-11 が足す。
 */

import type { Rule } from "../types.js";

import { R001 } from "./R001.js";
import { R006 } from "./R006.js";

/**
 * 照合エンジンの版（`reconciliationRun.engineVersion` / §2.4）。
 *
 * **ルールの追加・判定の変更で上げる。** 同じ版での再実行は差分のみを
 * 足し、版が違えば新しい Run になる（§5.4）。文言だけの修正では上げない
 * （既存の差異が二重に出る）。
 */
export const RECONCILIATION_ENGINE_VERSION = "1.0";

/**
 * 有効なルールの並び。**評価はこの順。**
 *
 * §3.1 の一覧（R001〜R014）のうち、実装済みのものだけがここに載る。
 * 載っていないコードは `ruleConfig` に設定があっても動かない。
 */
export const RULES: readonly Rule[] = [R001, R006];

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
