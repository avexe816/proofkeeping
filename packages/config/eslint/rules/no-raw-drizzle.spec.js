/**
 * no-raw-drizzle のユニットテスト。
 *
 * task: docs/tasks/P0-04.md
 * ルール: .claude/rules/testing.md
 */

import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";

import rule from "./no-raw-drizzle.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const REPO = "/home/runner/proofkeeping";

ruleTester.run("no-raw-drizzle", rule, {
  valid: [
    // 型だけの import は値を持ち込まないので正当。
    "import type { DrizzleD1Database } from 'drizzle-orm/d1';",
    "import { type DrizzleD1Database } from 'drizzle-orm/d1';",

    // drizzle-orm のクエリビルダはリポジトリ層で使う。禁止するのは drizzle( だけ。
    "import { and, eq } from 'drizzle-orm';",

    // 想定どおりの経路。
    "const db = await getTenantDb(env, ctx);",

    // 別モジュールの同名 export は対象外。
    "import { drizzle } from 'some-other-orm';",

    // ── 例外ファイル（仕様 §19.3）。ここで警告が出ないことが完了条件 ──
    {
      code: "import { drizzle } from 'drizzle-orm/d1';\nconst db = drizzle(binding);",
      filename: `${REPO}/packages/db/src/router.ts`,
    },
    {
      code: "import { drizzle } from 'drizzle-orm/d1';\nconst db = drizzle(binding);",
      filename: `${REPO}/packages/db/src/migrate.ts`,
    },
    {
      code: "import { drizzle } from 'drizzle-orm/d1';\nconst db = drizzle(binding);",
      filename: `${REPO}/packages/db/src/seed.ts`,
    },
  ],

  invalid: [
    {
      code: "import { drizzle } from 'drizzle-orm/d1';",
      filename: `${REPO}/apps/web/src/routes/api/v1/tasks.ts`,
      errors: [{ messageId: "importDrizzle" }],
    },
    {
      // 別名にしても import 側で捕まる。
      code: "import { drizzle as d } from 'drizzle-orm/d1';\nconst db = d(binding);",
      errors: [{ messageId: "importDrizzle" }],
    },
    {
      code: "const db = drizzle(binding);",
      errors: [{ messageId: "callDrizzle" }],
    },
    {
      // namespace import 経由。
      code: "import * as d1 from 'drizzle-orm/d1';\nconst db = d1.drizzle(binding);",
      errors: [{ messageId: "callDrizzle" }],
    },
    {
      // import と呼び出しの両方が証拠になる。
      code: "import { drizzle } from 'drizzle-orm/d1';\nconst db = drizzle(binding);",
      errors: [{ messageId: "importDrizzle" }, { messageId: "callDrizzle" }],
    },
    {
      // リポジトリ層も allowlist に入れていない（§19.3 の 3 ファイルのみ）。
      code: "import { drizzle } from 'drizzle-orm/d1';",
      filename: `${REPO}/packages/db/src/repositories/task.ts`,
      errors: [{ messageId: "importDrizzle" }],
    },
  ],
});
