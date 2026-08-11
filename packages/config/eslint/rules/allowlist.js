/**
 * カスタムルールの allowlist 照合。
 *
 * task: docs/tasks/P0-04.md
 *
 * allowlist を flat config の `files` override（該当ファイルでルールを off にする）
 * ではなくルール側のオプションで持つ理由:
 *   例外は「特定の数ファイル」であってファイルの種類ではない。ルール側に置けば
 *   「例外ファイルで警告が出ない」ことを RuleTester で直接検証できる。
 *   config 側の override に散らすとテストで担保できない。
 */

/** 区切りを posix に寄せる。開発機の OS で結果が変わらないようにする。 */
function toPosix(filepath) {
  return filepath.replace(/\\/g, "/");
}

/**
 * `filename` が allowlist のいずれかに一致するか。
 *
 * allowlist はリポジトリルートからの相対パスで書く。ESLint が渡す filename は
 * 絶対パスなので接尾辞で照合する。区切り `/` を挟んで比較するので、
 * `db/src/router.ts` が `mydb/src/router.ts` に誤って一致することはない。
 */
export function isAllowlisted(filename, allowlist) {
  if (typeof filename !== "string" || filename === "") return false;
  const path = toPosix(filename);
  return allowlist.some((entry) => {
    const target = toPosix(entry);
    return path === target || path.endsWith(`/${target}`);
  });
}

/** allowlist オプションを受け取るルールの共通 schema。 */
export const allowlistSchema = [
  {
    type: "object",
    properties: {
      allowlist: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
];

/**
 * 既定の allowlist を options で上書きできるようにする。
 * 上書きは RuleTester とデバッグ用。通常は既定値をそのまま使う。
 */
export function resolveAllowlist(context, fallback) {
  return context.options[0]?.allowlist ?? fallback;
}
