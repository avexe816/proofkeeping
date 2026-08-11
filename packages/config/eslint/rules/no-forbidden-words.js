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
 * **このファイルが `.js` なのは偶然ではない。** 下の語彙表は禁止語そのものを
 * 含むため、`*.ts` にすると CI の grep ジョブが自分自身を検出して落ちる。
 * grep の --include に `*.js` を足すなら、このファイルを除外すること。
 *
 * ── 自動化しない語 ──────────────────────────────────────
 * 契約 §5.1 の「チェック（監視の意味）」は文脈依存で、`チェックリスト`
 * （正当な業務語）と区別できない。機械判定に載せずレビューで見る。
 */

/**
 * [禁止語, 置換] の一覧。ui-writing.md §2 と PK-IMPL-CONTRACT §5.1 から採る。
 * 長い語が短い語を含む場合（不正検知 ⊃ 不正）は長い方だけを報告する。
 */
const FORBIDDEN = [
  // ui-writing.md §2
  ["不正検知", "稼働照合"],
  ["疑わしい取引", "要確認項目"],
  ["監視レポート", "差異レポート"],
  ["従業員の監視", "内部統制の支援"],
  ["疑わしい", "要確認項目"],
  ["監視", "稼働照合 / 内部統制の支援"],
  ["証拠", "証跡"],
  ["異常", "通常と違う点"],
  ["不審な点", "気づいたこと"],
  ["不審", "気づいたこと"],
  ["報告義務", "記録のお願い"],
  ["やり直し", "再清掃"],
  // PK-IMPL-CONTRACT §5.1
  ["保存に失敗しました", "端末に保存されています"],
  ["接続できません", "オフラインで動作中"],
  ["接続してください", "接続が戻ると自動で送信されます"],
  ["未送信のデータがあります", "送信待ちの記録"],
  ["未実施の項目", "できなかった項目"],
  ["不備あり", "記録された内容"],
  ["不備", "記録された内容"],
  ["無断宿泊", "（使用しない）"],
  ["不正", "（使用しない）"],
  ["疑い", "（使用しない）"],
  ["エラー", "（状態を事実として述べる）"],
  ["失敗", "（状態を事実として述べる）"],
];

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
