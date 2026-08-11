/**
 * no-literal-string のユニットテスト。
 *
 * task: docs/tasks/P0-04.md
 * ルール: .claude/rules/testing.md
 *
 * リポジトリに .tsx が存在しない（OPEN_QUESTIONS #001）ため、
 * このルールの検出能力を担保しているのはここだけ。
 */

import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import rule from "./no-literal-string.js";

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

const TSX = "/home/runner/proofkeeping/apps/web/src/routes/m/tasks.tsx";

ruleTester.run("no-literal-string", rule, {
  valid: [
    // 想定どおりの経路。
    { code: "const a = <p>{t('m.tasks.title')}</p>;", filename: TSX },
    { code: "const a = <img alt={t('m.photo.alt')} />;", filename: TSX },

    // ASCII は機械的な用途が大半なので対象にしない。
    { code: "const a = <div className='flex gap-2' data-testid='task-list' />;", filename: TSX },
    { code: "const a = <p>{count}</p>;", filename: TSX },

    // 記号だけの直書きは翻訳対象にならない。
    { code: "const a = <span>—</span>;", filename: TSX },

    // JSX の外側は対象外。i18n の定義そのものやログは通す。
    { code: "const messages = { 'm.tasks.title': '本日のタスク' };", filename: TSX },
  ],

  invalid: [
    {
      code: "const a = <p>本日のタスク</p>;",
      filename: TSX,
      errors: [{ messageId: "literal" }],
    },
    {
      // 式コンテナに逃がしても同じ。
      code: "const a = <p>{'本日のタスク'}</p>;",
      filename: TSX,
      errors: [{ messageId: "literal" }],
    },
    {
      code: "const a = <img alt='客室の写真' />;",
      filename: TSX,
      errors: [{ messageId: "literal" }],
    },
    {
      code: "const a = <button title={`開始する`}>{t('m.task.start')}</button>;",
      filename: TSX,
      errors: [{ messageId: "literal" }],
    },
    {
      // カタカナ・ひらがな・漢字のいずれでも検出する。
      code: "const a = <p>チェックリスト</p>;",
      filename: TSX,
      errors: [{ messageId: "literal" }],
    },
    {
      code: "const a = <div><span>清掃</span><span>検査</span></div>;",
      filename: TSX,
      errors: [{ messageId: "literal" }, { messageId: "literal" }],
    },
  ],
});
