/**
 * ヘルスチェック。**認証を要求しない唯一の API。**
 *
 *   GET /api/health
 *
 * task: docs/tasks/P0-20.md
 * 仕様: docs/PK-SPEC-P0.md §13.8
 *
 * ── 認証を掛けない理由と、その代わりに掛ける制約 ────────
 * 監視から叩く経路なので、セッションを持てない。代わりに
 * **返す内容を「件数と真偽」に絞る**（`packages/db/src/health.ts` の注記）。
 * 組織名・シャード番号・binding 名・例外メッセージを含めないこと。
 *
 * ── 状態はステータスコードで表す ────────────────────────
 * `degraded` は 503。監視は本文を解釈せずに落ちを検出できる。
 * **本文の `state` だけで表さない。** 200 を返すと外形監視が気付かない。
 */

import { checkHealth, type Env } from "@pk/db";
import { Hono } from "hono";

const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  const report = await checkHealth(c.env);
  return c.json(report, report.state === "ok" ? 200 : 503);
});

export default health;
