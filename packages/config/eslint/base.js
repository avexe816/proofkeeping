import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

import pk from "./plugin.js";

/**
 * ProofKeeping 共通 ESLint 設定（flat config）。
 *
 * カスタムルールは `./plugin.js`（実体は `./rules/*.js`）。P0-04 で追加した。
 *
 * 適用範囲の与え方が 2 系統ある。
 *   - アーキ 2 本（no-direct-shard-access / no-raw-drizzle）
 *     リポジトリ全域が禁止で、例外は数ファイル。例外リストはルール側の
 *     既定値に持たせてある（rules/allowlist.js）。ここでは有効化するだけ。
 *   - 文言 2 本（no-literal-string / no-forbidden-words）
 *     適用対象が「ファイルの種類」なので `files` で絞る。
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.wrangler/**",
      // React Router の型生成物（P0-14）。生成コードは検査しない。
      "**/.react-router/**",
      "ui-prototypes/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    plugins: { pk },
    languageOptions: {
      parserOptions: { projectService: true },
      globals: { ...globals.node },
    },
    rules: {
      // CLAUDE.md §5: any の新規追加禁止。unknown + Zod で絞る。
      "@typescript-eslint/no-explicit-any": "error",

      // architecture.md §1 / PK-SPEC-P0 §19.3。例外は router.ts・
      // マイグレーションランナー・シードのみ（ルール側の既定 allowlist）。
      "pk/no-direct-shard-access": "error",

      // architecture.md §2 第1層 / PK-SPEC-P0 §19.4。
      "pk/no-raw-drizzle": "error",
    },
  },
  {
    // ui-writing.md §1: UI 文字列を JSX に直書きしない。
    // P0-14 で apps/web に .tsx が入り、このルールが実ファイルに当たるようになった
    // （tsconfig の jsx / include — OPEN_QUESTIONS #001）。
    files: ["**/*.tsx"],
    rules: {
      "pk/no-literal-string": "error",
    },
  },
  {
    // React Router（P0-14）は loader / action からの `throw redirect(...)` を
    // 制御の手段として使う。redirect() が返すのは `Response` で `Error` ではない。
    // **`Error` 以外を投げてよいのはこの形だけ。** 文字列やオブジェクトを
    // 投げる余地は残さない。
    // lib/platform は運営面の門（PF-01）。404 の Response を投げる。
    files: [
      "apps/web/src/routes/**/*.{ts,tsx}",
      "apps/web/src/lib/ui/**/*.ts",
      "apps/web/src/lib/platform/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/only-throw-error": [
        "error",
        { allow: [{ from: "package", package: "@cloudflare/workers-types", name: "Response" }] },
      ],
    },
  },
  {
    // ui-writing.md §2 / PK-IMPL-CONTRACT §5.1 の禁止語。
    // 全 TS に当てない。§5.1 は「エラー」「失敗」を含むため、
    // 通常のエラーハンドリングまで落ちる。対象は UI 文言を持つファイルだけ。
    // **.json を対象に含めない。** ESLint は既定で JSON を解析せず、
    // 含めると TS パーサが JSON を式として読んで parse error になる。
    // P0-15 で文言が locales/*.json へ移ったぶんは
    // apps/web/src/locales/locales.spec.ts が同じ語彙表で検査する
    // （rules/forbidden-words-list.js が両者の唯一の出どころ）。
    //
    // ── P4-15 が足した範囲（PK-SPEC-P4 §10.5）────────────────
    // §10.5 は「UI・API レスポンス・PDF に『不正』という語が存在しない」を
    // 出荷判定にしている。UI（.tsx）と PDF（packages/pdf）は元から対象だが、
    // **API レスポンスに載る日本語は照合エンジンが作っていた**
    // （`FindingDraft` の `title` / `summary` が `auditFinding` を経て
    // `GET /api/v1/findings` と W-07 にそのまま出る）。
    // その組み立てを行う 2 か所を足してある。
    //
    // **spec を外してある。** テストの `it("誤検知が 3 回以上なら…")` は
    // 画面に出る文言ではない。
    files: [
      "**/*.tsx",
      "**/locales/**/*.{ts,tsx}",
      "packages/pdf/**/*.{ts,tsx}",
      "packages/engine/src/reconciliation/**/*.ts",
      "apps/web/src/lib/reconciliation/**/*.ts",
      // ── P5-04 が足した範囲（PK-SPEC-P5 §3.4）────────────────
      // 請求明細の取引内容（`description`）は `packages/billing` が組み立て、
      // `GET /api/v1/invoices/:id` と請求書 PDF（§8.1）にそのまま載る。
      // 発行後は帳票に固定されて訂正できない（billing.md §2）。
      "packages/billing/src/**/*.ts",
    ],
    ignores: ["**/*.spec.{ts,tsx}"],
    rules: {
      "pk/no-forbidden-words": "error",
    },
  },
  {
    // 設定ファイル自身は型情報なしで検査する。
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettierConfig,
);
