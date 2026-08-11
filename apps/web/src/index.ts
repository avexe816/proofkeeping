import { Hono } from "hono";

/**
 * Workers のエントリポイント。
 *
 * ルートはこの task では一切定義しない。
 * - wrangler.toml と bindings: P0-02
 * - middleware（session / tenant / resourceGuard）: P0-08 以降
 * - /health: P0-20
 */
const app = new Hono();

export default app;
