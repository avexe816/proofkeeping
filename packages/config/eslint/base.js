import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * ProofKeeping 共通 ESLint 設定（flat config）。
 *
 * シャード直接アクセス・raw drizzle・JSX の日本語直書きを検出するカスタムルールは
 * P0-04 でここに追加する。
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.wrangler/**",
      "ui-prototypes/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true },
      globals: { ...globals.node },
    },
    rules: {
      // CLAUDE.md §5: any の新規追加禁止。unknown + Zod で絞る。
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // 設定ファイル自身は型情報なしで検査する。
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettierConfig,
);
