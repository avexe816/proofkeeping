/**
 * `env.SHARD_00` 〜 `env.SHARD_15` への直接アクセスを禁止する。
 *
 * 仕様: docs/PK-SPEC-P0.md §19.3
 * ルール: .claude/rules/architecture.md §1
 * task:  docs/tasks/P0-04.md
 *
 * ── なぜ lint で落とすのか ──────────────────────────────
 * シャードを取り違えても実行時エラーにならない。存在する別の D1 に
 * 正常に読み書きが通るだけで、404 にもならず、テナント越境テストにも
 * 引っかからない（分離自体は破れていないため）。結果として同一テナントの
 * データが複数シャードへ静かに分裂する。人間のレビューで捕まえ続けるのは
 * 現実的でないので機械で落とす（docs/DECISIONS.md #007）。
 *
 * ── 検出しないもの ──────────────────────────────────────
 * - `env.SHARD_COUNT` / `env.SHARD_MAP`：正当な設定値・KV。数字だけを見る
 *   正規表現なので自然に外れる。
 * - `interface ShardBindings { SHARD_00: D1Database }`：TSPropertySignature
 *   であって member access ではない。`packages/db/src/env.ts` を allowlist に
 *   入れる必要がないのはこのため。
 * - `{ SHARD_00: db }` のようなオブジェクト構築（テストダブル）。
 *
 * ── 既知の限界 ──────────────────────────────────────────
 * `env[key]`（key を実行時に組み立てる形）は静的に追えないため検出できない。
 * 現状これを行うのは router.ts 自身だけで、allowlist 済み。この抜け道を
 * 塞ぐ手段は型側にないので、レビューで見る前提とする。
 */

import { allowlistSchema, isAllowlisted, resolveAllowlist } from "./allowlist.js";

/**
 * 仕様 §19.3 が定める例外。「router.ts、マイグレーションランナー、シードのみ」。
 *
 * migrate.ts / seed.ts はまだ存在しない（それぞれ P0-06 / P0-18 が作る）。
 * 先に名前を確定して置いてある。別名で作られた場合は lint がその場で落ちる
 * だけなので、黙って穴が開くことはない（docs/DECISIONS.md #009）。
 */
const DEFAULT_ALLOWLIST = [
  "packages/db/src/router.ts",
  "packages/db/src/migrate.ts",
  "packages/db/src/seed.ts",
];

/** `SHARD_07` のような binding 名。`SHARD_COUNT` / `SHARD_MAP` は含まない。 */
const SHARD_BINDING = /^SHARD_\d+$/;

/** 動的キー（`` `SHARD_${i}` ``）の接頭辞。 */
const SHARD_PREFIX = "SHARD_";

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "env.SHARD_XX への直接アクセスを禁止する。シャードの解決は getTenantDb() だけが行う。",
    },
    schema: allowlistSchema,
    messages: {
      directAccess:
        "env.{{name}} に直接アクセスしないこと。getTenantDb(env, ctx) を使う（architecture.md §1）。",
      dynamicAccess:
        "シャード binding のキーを組み立てないこと。getTenantDb(env, ctx) を使う（architecture.md §1）。",
    },
  },

  create(context) {
    const allowlist = resolveAllowlist(context, DEFAULT_ALLOWLIST);
    if (isAllowlisted(context.filename, allowlist)) return {};

    /** 静的に名前が判る参照。 */
    function reportIfShardName(node, name) {
      if (typeof name === "string" && SHARD_BINDING.test(name)) {
        context.report({ node, messageId: "directAccess", data: { name } });
      }
    }

    return {
      MemberExpression(node) {
        if (!node.computed) {
          if (node.property.type === "Identifier") {
            reportIfShardName(node.property, node.property.name);
          }
          return;
        }

        // env["SHARD_07"]
        if (node.property.type === "Literal") {
          reportIfShardName(node.property, node.property.value);
          return;
        }

        // env[`SHARD_07`] / env[`SHARD_${i}`]
        if (node.property.type === "TemplateLiteral") {
          const head = node.property.quasis[0]?.value.cooked ?? "";
          if (node.property.expressions.length === 0) {
            reportIfShardName(node.property, head);
          } else if (head.startsWith(SHARD_PREFIX)) {
            // `SHARD_${...}` はシャード binding のキー生成以外に用途がない。
            context.report({ node: node.property, messageId: "dynamicAccess" });
          }
        }
      },

      // const { SHARD_07 } = env
      "ObjectPattern > Property"(node) {
        if (node.computed) return;
        if (node.key.type === "Identifier") {
          reportIfShardName(node.key, node.key.name);
        } else if (node.key.type === "Literal") {
          reportIfShardName(node.key, node.key.value);
        }
      },
    };
  },
};
