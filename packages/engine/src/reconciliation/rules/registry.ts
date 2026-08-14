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
 * ── いま載っているもの ──────────────────────────────────
 * P4-04 が R001 / R006、P4-11 が R003 / R004 / R005、
 * P4-12 が R002 / R010 / R012 / R013 / R014 を足した。**10 個。**
 *
 * ── 載っていない 4 つ（R007 / R008 / R009 / R011）───────
 * §3 に**条件の記述が無い。** §3.1 の一覧に名称・重要度・必要系統だけが
 * あり、閾値も判定式も定められていない（OPEN_QUESTIONS #066）。
 * R003 に倣って `p90 + 1` を当てるのは推測になるため、
 * **仕様が決まるまで実装しない**（CLAUDE.md §1.4）。
 * 決まったら、このファイルに 1 行足すだけで動く。
 */

import type { Rule } from "../types.js";

import { R001 } from "./R001.js";
import { R002 } from "./R002.js";
import { R003 } from "./R003.js";
import { R004 } from "./R004.js";
import { R005 } from "./R005.js";
import { R006 } from "./R006.js";
import { R010 } from "./R010.js";
import { R012 } from "./R012.js";
import { R013 } from "./R013.js";
import { R014 } from "./R014.js";

/**
 * 照合エンジンの版（`reconciliationRun.engineVersion` / §2.4）。
 *
 * **ルールの追加・判定の変更で上げる。** 同じ版での再実行は差分のみを
 * 足し、版が違えば新しい Run になる（§5.4）。文言だけの修正では上げない
 * （既存の差異が二重に出る）。
 *
 * `1.2` = P6-08。R002 / R013 が清掃タスクの前後 10 分の解錠を外し、
 * `actorType` 不明の解錠を数に入れるようになった（PK-SPEC-P6 §4.3・§4.4）。
 * **判定そのものが変わっている**ので上げる。
 */
export const RECONCILIATION_ENGINE_VERSION = "1.2";

/**
 * 有効なルールの並び。**評価はこの順。**
 *
 * §3.1 の一覧（R001〜R014）のうち、実装済みのものだけがここに載る。
 * 載っていないコードは `ruleConfig` に設定があっても動かない。
 */
export const RULES: readonly Rule[] = [R001, R002, R003, R004, R005, R006, R010, R012, R013, R014];

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
