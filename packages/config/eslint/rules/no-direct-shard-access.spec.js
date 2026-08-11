/**
 * no-direct-shard-access のユニットテスト。
 *
 * task: docs/tasks/P0-04.md
 * ルール: .claude/rules/testing.md
 *
 * 完了条件「例外ファイルで警告が出ない」は valid 側の filename 指定で担保する。
 */

import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import rule from "./no-direct-shard-access.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

/** ESLint は絶対パスを渡すので、テストも絶対パスで書く。 */
const REPO = "/home/runner/proofkeeping";

ruleTester.run("no-direct-shard-access", rule, {
  valid: [
    // 設定値と KV。名前が似ているだけで binding ではない。
    "const n = env.SHARD_COUNT;",
    "await env.SHARD_MAP.get('shard:o7k2m9');",

    // 型宣言は member access ではない。env.ts を allowlist に入れずに済む根拠。
    "interface ShardBindings { SHARD_00: D1Database; SHARD_01?: D1Database; }",

    // テストダブルの構築。読み出しではない。
    "const shards = { SHARD_00: fakeD1('SHARD_00') };",

    // 実行時に組み立てたキーは静的に追えない（ルールの既知の限界）。
    "const db = env[key];",

    // ── 例外ファイル（仕様 §19.3）。ここで警告が出ないことが完了条件 ──
    {
      code: "const db = env[`SHARD_${idx}`];",
      filename: `${REPO}/packages/db/src/router.ts`,
    },
    {
      code: "const db = env.SHARD_07;",
      filename: `${REPO}/packages/db/src/migrate.ts`,
    },
    {
      code: "const db = env.SHARD_07;",
      filename: `${REPO}/packages/db/src/seed.ts`,
    },
  ],

  invalid: [
    {
      code: "const db = env.SHARD_07;",
      filename: `${REPO}/apps/web/src/index.ts`,
      errors: [{ messageId: "directAccess" }],
    },
    {
      code: "const db = env['SHARD_07'];",
      errors: [{ messageId: "directAccess" }],
    },
    {
      code: "const db = c.env.SHARD_00.prepare('select 1');",
      errors: [{ messageId: "directAccess" }],
    },
    {
      code: "const { SHARD_07 } = env;",
      errors: [{ messageId: "directAccess" }],
    },
    {
      // 静的なテンプレートリテラルも通さない。
      code: "const db = env[`SHARD_07`];",
      errors: [{ messageId: "directAccess" }],
    },
    {
      // キーの組み立ては router.ts の外では禁止。
      code: "const db = env[`SHARD_${idx}`];",
      errors: [{ messageId: "dynamicAccess" }],
    },
    {
      // 名前が似ているだけのファイルは例外にならない。
      code: "const db = env.SHARD_07;",
      filename: `${REPO}/packages/db/src/router-helpers.ts`,
      errors: [{ messageId: "directAccess" }],
    },
  ],
});
