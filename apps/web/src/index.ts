import type { Env } from "@pk/db";
import { Hono } from "hono";

import auth from "./routes/api/v1/auth.js";

/**
 * Workers のエントリポイント。
 *
 * - wrangler.toml と bindings: P0-02（完了。binding の型は `Env`）
 * - 認証 API（/api/v1/auth）: P0-08
 * - middleware（session / tenant / resourceGuard）: P0-10
 * - /health: P0-20
 */
const app = new Hono<{ Bindings: Env }>();

// 認証だけはセッション middleware（P0-10）より前段に置く。
// セッションを作る経路がセッションを要求すると入口が無くなる。
app.route("/api/v1/auth", auth);

export default app;
