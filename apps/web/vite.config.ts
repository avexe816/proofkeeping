import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * Vite の設定。`pnpm dev` と `pnpm build` の実体。
 *
 * task: docs/tasks/P0-14.md
 *
 * ── Worker のエントリは wrangler.toml の main ────────────
 * `@cloudflare/vite-plugin` は wrangler.toml を読み、`main`（`src/index.ts`）を
 * Worker のエントリとして扱う。**エントリをここに二重定義しない。**
 * binding も wrangler.toml のものがそのまま dev で使える。
 *
 * `viteEnvironment.name` を `ssr` にして、React Router のサーバービルドと
 * Cloudflare の Worker 環境を同じ環境として束ねる。これを外すと
 * `virtual:react-router/server-build` が Worker 側から解決できない。
 */
export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()],
});
