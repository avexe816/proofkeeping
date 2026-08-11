/**
 * JSX への日本語直書きを禁止する。UI 文字列は必ず `t("key")` を経由させる。
 *
 * ルール: .claude/rules/ui-writing.md §1
 * task:  docs/tasks/P0-04.md
 *
 * ── なぜ日本語だけを見るのか ────────────────────────────
 * JSX に現れる ASCII 文字列は className・data 属性・記号など機械的なものが
 * 大半で、全部を禁止すると誤検知が実害になる。既定言語が日本語で、
 * モバイルのみ英語対応（ui-writing.md §1）という構成上、翻訳から漏れて
 * 困るのは日本語の直書きに限られる。
 *
 * ── 現時点の適用範囲 ────────────────────────────────────
 * リポジトリに `.tsx` は 1 件も存在しない（UI フレームワークが未決のため。
 * docs/OPEN_QUESTIONS.md #001）。よって当面このルールは実ファイルに当たらず、
 * 検出能力は RuleTester のテストだけで担保している。最初の `.tsx` を作る
 * P0-14 で、parser の JSX 設定と projectService の結線を行うこと。
 */

/**
 * ひらがな・カタカナ・漢字（CJK 統合漢字と拡張A）・半角カナ。
 * 句読点だけの文字列は対象にしない（記号は機械的な用途がある）。
 */
const JAPANESE = /[぀-ゟ゠-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "JSX に日本語を直書きせず、i18n のキー経由にする。",
    },
    schema: [],
    messages: {
      literal:
        "JSX に日本語を直書きしないこと。t(\"key\") 経由にする（ui-writing.md §1）: {{text}}",
    },
  },

  create(context) {
    function report(node, raw) {
      const text = raw.trim();
      if (text === "" || !JAPANESE.test(text)) return;
      context.report({
        node,
        messageId: "literal",
        // 長文をそのままメッセージに出すと読みにくいので頭だけ出す。
        data: { text: text.length > 20 ? `${text.slice(0, 20)}…` : text },
      });
    }

    /** `{"日本語"}` / `{`日本語`}` のように式コンテナへ逃がした直書き。 */
    function reportExpression(node) {
      if (node.type === "Literal" && typeof node.value === "string") {
        report(node, node.value);
        return;
      }
      if (node.type === "TemplateLiteral") {
        for (const quasi of node.quasis) {
          report(quasi, quasi.value.cooked ?? quasi.value.raw);
        }
      }
    }

    return {
      // <p>日本語</p>
      JSXText(node) {
        report(node, node.value);
      },

      // <img alt="日本語" />
      JSXAttribute(node) {
        const value = node.value;
        if (value && value.type === "Literal" && typeof value.value === "string") {
          report(value, value.value);
        }
      },

      // <p>{"日本語"}</p> / <img alt={"日本語"} />
      JSXExpressionContainer(node) {
        reportExpression(node.expression);
      },
    };
  },
};
