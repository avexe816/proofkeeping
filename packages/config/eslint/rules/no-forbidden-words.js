/**
 * UI 文言の禁止語を検出する。
 *
 * ルール: .claude/rules/ui-writing.md §2
 * 契約:   docs/PK-IMPL-CONTRACT.md §5.1（禁止語と置換）
 * task:   docs/tasks/P0-04.md
 *
 * ── なぜ「UI 文言ファイル」に限定するのか ──────────────
 * 契約 §5.1 の一覧には「エラー」「失敗」「異常」が含まれる。これを全 TS の
 * 文字列に当てると `throw new Error("...")` 周りの通常のコードまで落ちる。
 * §5.1 自身が対象を「UI文言」と限定しているので、適用範囲は flat config 側の
 * `files`（tsx ファイル、locales 配下、packages/pdf 配下）で絞る。
 * ルール自体は範囲を持たない。
 *
 * ── CI の grep ジョブとの関係 ────────────────────────────
 * `.github/workflows/ci.yml` の forbidden-words ジョブは複合語
 * （`不正検知` など）を apps / packages 配下の *.ts / *.tsx / *.json へ
 * 一律に当てる。こちらは UI 文言ファイルに限って単語単位で見る。
 * 役割が違うので両方残す。
 *
 * **語彙表が `.js` なのは偶然ではない。** `./forbidden-words-list.js` は
 * 禁止語そのものを含むため、`*.ts` にすると CI の grep ジョブが自分自身を
 * 検出して落ちる。grep の --include に `*.js` を足すなら除外すること。
 * P0-15 でルール本体から切り出した（locales の spec が同じ表を読む）。
 *
 * ── 自動化しない語 ──────────────────────────────────────
 * 契約 §5.1 の「チェック（監視の意味）」は文脈依存で、`チェックリスト`
 * （正当な業務語）と区別できない。機械判定に載せずレビューで見る。
 */

import { FORBIDDEN } from "./forbidden-words-list.js";

/**
 * 禁止語の出現位置を求める。長い語に完全に含まれる短い語は捨てる。
 * 「不正検知」1 件に対して「不正」でもう 1 件報告されると、直すべき語が
 * どちらか読み取れなくなるため。
 */
function findMatches(text) {
  const found = [];
  for (const [word, replacement] of FORBIDDEN) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(word, from);
      if (index === -1) break;
      found.push({ index, end: index + word.length, word, replacement });
      from = index + word.length;
    }
  }

  // 開始位置の昇順、同位置なら長い語を先に見る。
  found.sort((a, b) => a.index - b.index || b.end - a.end);

  const kept = [];
  for (const match of found) {
    const covered = kept.some((k) => k.index <= match.index && match.end <= k.end);
    if (!covered) kept.push(match);
  }
  return kept;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "UI 文言に禁止語を使わない（ui-writing.md §2 / PK-IMPL-CONTRACT §5.1）。",
    },
    schema: [],
    messages: {
      forbidden: "UI 文言に「{{word}}」を使わないこと。置換: {{replacement}}",
    },
  },

  create(context) {
    function check(node, text) {
      if (typeof text !== "string" || text === "") return;
      for (const match of findMatches(text)) {
        context.report({
          node,
          messageId: "forbidden",
          data: { word: match.word, replacement: match.replacement },
        });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral(node) {
        for (const quasi of node.quasis) {
          check(quasi, quasi.value.cooked ?? quasi.value.raw);
        }
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
};
