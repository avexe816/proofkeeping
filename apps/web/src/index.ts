import { Hono } from "hono";

import {
  apiErrorHandler,
  apiNotFoundHandler,
  useTenantMiddleware,
  type AppEnv,
} from "./middleware/index.js";
import auth from "./routes/api/v1/auth.js";

/**
 * Workers のエントリポイント。
 *
 * - wrangler.toml と bindings: P0-02（完了。binding の型は `Env`）
 * - 認証 API（/api/v1/auth）: P0-08 / P0-09
 * - middleware（session / tenant / resourceGuard）: P0-10
 * - /health: P0-20
 */
const app = new Hono<AppEnv>();

/**
 * 例外と未定義経路の写像は**最上位に置く。**
 *
 * `notFound` は `app.route()` で合成した子アプリからは引き継がれないため
 * （`middleware/index.ts` の冒頭）、ここでしか登録できない。
 * `onError` は子アプリ側にも掛かるが、認証 API（下で先に生やす）を含め
 * 全経路を覆うために最上位にも置く。**素の例外をログへ流さない**
 * （architecture.md §1 — シャード番号を露出しない）。
 */
app.onError(apiErrorHandler());
app.notFound(apiNotFoundHandler());

// 認証だけはセッション middleware（P0-10）より前段に置く。
// セッションを作る経路がセッションを要求すると入口が無くなる。
app.route("/api/v1/auth", auth);

/**
 * 認証を要求する API。**以降の API はこの `api` へ足すこと。**
 *
 * `app` に直接生やすと middleware が掛からず、`TenantContext` の無いまま
 * ハンドラが動く。`getTenant()` が例外にするので静かには壊れないが、
 * そもそも生やせる場所を 1 つにしておく。
 */
const api = new Hono<AppEnv>();
useTenantMiddleware(api);
app.route("/api/v1", api);

export default app;
