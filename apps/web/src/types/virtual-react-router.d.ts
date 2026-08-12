/**
 * `virtual:react-router/server-build` の型宣言。
 *
 * task: docs/tasks/P0-14.md
 *
 * Vite が組み立てるサーバービルドの仮想モジュール。実体はビルド時に生成される
 * ため `@react-router/dev` は型を出さない。Worker のエントリ
 * （`src/index.ts`）がこれを `import()` するので、ここで形だけ宣言する。
 *
 * **中身を増やさないこと。** `ServerBuild` の再定義ではなく、
 * 名前空間の形を `ServerBuild` に一致させるための宣言。
 */
declare module "virtual:react-router/server-build" {
  import type { ServerBuild } from "react-router";

  // 省略可能な項目（`basename` など）はここに書かない。`exactOptionalPropertyTypes`
  // の下では `string | undefined` が `basename?: string` に代入できず、
  // **無いこと**が正しく表現できるのは宣言しない側だから。
  export const entry: ServerBuild["entry"];
  export const routes: ServerBuild["routes"];
  export const assets: ServerBuild["assets"];
  export const publicPath: ServerBuild["publicPath"];
  export const assetsBuildDirectory: ServerBuild["assetsBuildDirectory"];
  export const future: ServerBuild["future"];
  export const ssr: ServerBuild["ssr"];
  export const isSpaMode: ServerBuild["isSpaMode"];
  export const prerender: ServerBuild["prerender"];
  export const routeDiscovery: ServerBuild["routeDiscovery"];
}
