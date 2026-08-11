/**
 * ProofKeeping のカスタム ESLint ルールをまとめた plugin オブジェクト。
 *
 * task: docs/tasks/P0-04.md
 *
 * flat config へは `plugins: { pk: plugin }` として渡し、
 * `"pk/no-direct-shard-access"` の形で有効化する（base.js を参照）。
 *
 * `no-restricted-syntax` のセレクタで済ませていない理由:
 *   CLAUDE.md §4 と architecture.md §1 がルールを固有名で参照している。
 *   名前付きのルールにしておかないと、違反時のメッセージからも
 *   docs からも同じ名前で辿れない。ファイル単位の allowlist と
 *   ユニットテストも持てない。
 */

import noDirectShardAccess from "./rules/no-direct-shard-access.js";
import noForbiddenWords from "./rules/no-forbidden-words.js";
import noLiteralString from "./rules/no-literal-string.js";
import noRawDrizzle from "./rules/no-raw-drizzle.js";

export default {
  meta: {
    name: "@pk/eslint-plugin",
    version: "0.0.0",
  },
  rules: {
    "no-direct-shard-access": noDirectShardAccess,
    "no-raw-drizzle": noRawDrizzle,
    "no-literal-string": noLiteralString,
    "no-forbidden-words": noForbiddenWords,
  },
};
