import type { Env } from "@pk/db";
import { Hono } from "hono";

/**
 * Workers のエントリポイント。
 *
 * ルートはこの task では一切定義しない。
 * - wrangler.toml と bindings: P0-02（完了。binding の型は `Env`）
 * - middleware（session / tenant / resourceGuard）: P0-08 以降
 * - /health: P0-20
 */
const app = new Hono<{ Bindings: Env }>();

export default app;
