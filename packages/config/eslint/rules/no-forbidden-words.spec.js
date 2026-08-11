/**
 * no-forbidden-words のユニットテスト。
 *
 * task: docs/tasks/P0-04.md
 * ルール: .claude/rules/testing.md
 *
 * 適用範囲（UI 文言ファイルに限る）は flat config 側の `files` が持つため、
 * ここではルール単体の検出だけを見る。
 */

import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import rule from "./no-forbidden-words.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("no-forbidden-words", rule, {
  valid: [
    // ui-writing.md §2 の「使う」側の語。
    "const a = '稼働照合';",
    "const a = '要確認項目';",
    "const a = '差異レポート';",
    "const a = '証跡';",
    "const a = '通常と違う点';",
    "const a = '気づいたこと';",
    "const a = '記録のお願い';",
    "const a = '再清掃';",
    "const a = '内部統制の支援';",

    // 正当な業務語。「チェック（監視の意味）」は文脈依存なので機械判定に載せていない。
    "const a = 'チェックリスト';",
    "const a = '本日のタスク';",

    // 文字列以外は見ない。
    "const 監視 = 1;",
  ],

  invalid: [
    {
      code: "const a = '不正検知';",
      // 「不正検知」に含まれる「不正」で二重に報告しない。
      errors: [{ messageId: "forbidden", data: { word: "不正検知", replacement: "稼働照合" } }],
    },
    {
      code: "const a = '監視レポート';",
      errors: [
        { messageId: "forbidden", data: { word: "監視レポート", replacement: "差異レポート" } },
      ],
    },
    {
      code: "const a = '従業員の監視';",
      errors: [
        { messageId: "forbidden", data: { word: "従業員の監視", replacement: "内部統制の支援" } },
      ],
    },
    {
      code: "const a = '疑わしい取引';",
      errors: [
        { messageId: "forbidden", data: { word: "疑わしい取引", replacement: "要確認項目" } },
      ],
    },
    {
      code: "const a = '不審な点はありましたか';",
      errors: [
        { messageId: "forbidden", data: { word: "不審な点", replacement: "気づいたこと" } },
      ],
    },
    {
      code: "const a = '異常値です';",
      errors: [{ messageId: "forbidden", data: { word: "異常", replacement: "通常と違う点" } }],
    },
    {
      code: "const a = '証拠として保管します';",
      errors: [{ messageId: "forbidden", data: { word: "証拠", replacement: "証跡" } }],
    },
    {
      code: "const a = 'やり直しをお願いします';",
      errors: [{ messageId: "forbidden", data: { word: "やり直し", replacement: "再清掃" } }],
    },
    {
      // PK-IMPL-CONTRACT §5.1。長い語を優先するので「失敗」では報告しない。
      code: "const a = '保存に失敗しました';",
      errors: [
        {
          messageId: "forbidden",
          data: { word: "保存に失敗しました", replacement: "端末に保存されています" },
        },
      ],
    },
    {
      code: "const a = '接続できません';",
      errors: [
        { messageId: "forbidden", data: { word: "接続できません", replacement: "オフラインで動作中" } },
      ],
    },
    {
      // テンプレートリテラルも JSX テキストも対象。
      code: "const a = `${n}件の異常`;",
      errors: [{ messageId: "forbidden" }],
    },
    {
      code: "const a = <p>不正が検出されました</p>;",
      errors: [{ messageId: "forbidden", data: { word: "不正", replacement: "（使用しない）" } }],
    },
    {
      // 1 つの文字列に複数の禁止語。
      code: "const a = '監視レポートに異常を記録';",
      errors: [{ messageId: "forbidden" }, { messageId: "forbidden" }],
    },
  ],
});
