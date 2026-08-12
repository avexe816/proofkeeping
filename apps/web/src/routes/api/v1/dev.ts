/**
 * シード投入（dev のみ）。**本番では 404。**
 *
 *   POST /api/v1/dev/seed
 *   body: { "ownerPassword": "..." }  ※省略時 "testpass-01"
 *
 * task: docs/tasks/P0-18.md（OPEN_QUESTIONS #031 の解消）
 *
 * ── 本番で動かない ──────────────────────────────────────
 * `ENVIRONMENT !== "local"` のとき 404 を返す。preview / staging / production
 * で誤って実行されないようにする。**本番にはこの経路が存在しないことが重要。**
 *
 * ── 認証を要求しない ────────────────────────────────────
 * ローカル開発で初期データが無いとログインすらできないため、
 * セッションを持たない状態で叩ける必要がある。
 * **本番では経路自体が 404 になるので、認証の欠如は問題にならない。**
 */

import { Hono } from "hono";

import type { Env } from "@pk/db";

import { runSeed } from "../../../lib/seed/runSeed.js";

const dev = new Hono<{ Bindings: Env }>();

dev.post("/seed", async (c) => {
  if (c.env.ENVIRONMENT !== "local") {
    return c.json({ error: "Not Found" }, 404);
  }

  const body: unknown = await c.req.json().catch(() => ({}));
  const ownerPassword =
    typeof body === "object" &&
    body !== null &&
    "ownerPassword" in body &&
    typeof (body as Record<string, unknown>).ownerPassword === "string" &&
    ((body as Record<string, unknown>).ownerPassword as string).length >= 8
      ? ((body as Record<string, unknown>).ownerPassword as string)
      : "testpass-01";

  const result = await runSeed(
    c.env,
    { ownerPassword },
    new Date(),
  );

  return c.json({
    ok: true,
    organizationId: result.organizationId,
    orgShortId: result.orgShortId,
    properties: result.properties,
    rooms: result.rooms,
    cleaners: result.cleaners,
    checklistTemplates: result.checklistTemplates,
    message: `Seed complete: ${String(result.properties)} properties, ${String(result.rooms)} rooms, ${String(result.cleaners)} cleaners. Login with orgShortId=${result.orgShortId} + staff no. + password.`,
  });
});

export default dev;
