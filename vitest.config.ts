import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/**/*.spec.ts",
      "packages/*/src/**/*.spec.ts",
      "apps/*/src/**/*.spec.ts",
      // ESLint カスタムルール（P0-04）。packages/config は src/ を持たず、
      // ルールの実体が .js なので上の 3 パターンに掛からない。
      "packages/config/eslint/**/*.spec.js",
    ],
  },
});
