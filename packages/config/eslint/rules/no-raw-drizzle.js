/**
 * リポジトリ層以外での `drizzle(` 呼び出しを禁止する。
 *
 * 仕様: docs/PK-SPEC-P0.md §19.3, §19.4 第1層
 * ルール: .claude/rules/architecture.md §1, §2
 * task:  docs/tasks/P0-04.md
 *
 * ── なぜ lint で落とすのか ──────────────────────────────
 * `drizzle(db)` を自前で呼べる場所では、`getTenantDb()` を経由せずに
 * D1 を掴める。テナント分離の第 1 層（リポジトリ層での organizationId
 * 強制注入）は「全クエリがリポジトリを通る」ことが前提なので、この入口が
 * 1 つでも開いていれば層として成立しない（§19.4）。
 *
 * ── allowlist の範囲 ────────────────────────────────────
 * §19.4 は「リポジトリ以外のファイルで禁止」と書き、§19.3 は例外を
 * 「router.ts、マイグレーションランナー、シード」の 3 つと列挙していて
 * 両者はズレている。ここでは狭い方（3 ファイル）を採る。
 * P0-07 のリポジトリは `getTenantDb()` から db を受け取る設計であり
 * `drizzle(` を呼ぶ必要がないため、含めても穴が広がるだけで得がない。
 * リポジトリ側で必要になったら lint が止め、設計の誤りに気づける。
 *
 * ── import 側で捕まえる理由 ──────────────────────────────
 * 呼び出し名だけを見ると `import { drizzle as d }` で回避できてしまう。
 * import specifier を報告対象にすれば別名でも必ず捕まる。
 */

import { allowlistSchema, isAllowlisted, resolveAllowlist } from "./allowlist.js";

/** 仕様 §19.3 の例外。migrate.ts / seed.ts は未作成（P0-06 / P0-18）。 */
const DEFAULT_ALLOWLIST = [
  "packages/db/src/router.ts",
  "packages/db/src/migrate.ts",
  "packages/db/src/seed.ts",
];

/** `drizzle-orm` 本体とサブパス（`drizzle-orm/d1` など）。 */
const DRIZZLE_MODULE = /^drizzle-orm(\/|$)/;

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "リポジトリ層以外での drizzle( 呼び出しを禁止する。DB へは getTenantDb() 経由で到達する。",
    },
    schema: allowlistSchema,
    messages: {
      importDrizzle:
        "drizzle をここで import しないこと。DB は getTenantDb(env, ctx) から受け取る（architecture.md §2 第1層）。",
      callDrizzle:
        "drizzle() を呼ばないこと。DB は getTenantDb(env, ctx) から受け取る（architecture.md §2 第1層）。",
    },
  },

  create(context) {
    const allowlist = resolveAllowlist(context, DEFAULT_ALLOWLIST);
    if (isAllowlisted(context.filename, allowlist)) return {};

    return {
      ImportDeclaration(node) {
        // `import type { DrizzleD1Database }` は値を持ち込まないので正当。
        if (node.importKind === "type") return;
        if (typeof node.source.value !== "string") return;
        if (!DRIZZLE_MODULE.test(node.source.value)) return;

        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          if (spec.importKind === "type") continue;
          if (spec.imported.type === "Identifier" && spec.imported.name === "drizzle") {
            context.report({ node: spec, messageId: "importDrizzle" });
          }
        }
      },

      CallExpression(node) {
        const callee = node.callee;

        // drizzle(...)
        if (callee.type === "Identifier" && callee.name === "drizzle") {
          context.report({ node: callee, messageId: "callDrizzle" });
          return;
        }

        // import * as d1 from "drizzle-orm/d1" 経由の d1.drizzle(...)
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "drizzle"
        ) {
          context.report({ node: callee.property, messageId: "callDrizzle" });
        }
      },
    };
  },
};
