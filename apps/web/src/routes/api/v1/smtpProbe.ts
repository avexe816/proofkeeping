/**
 * SMTP の疎通確認の口（P5-21）。**メールは 1 通も送らない。**
 *
 *   POST /api/v1/dev/smtp-probe
 *   header: x-pk-smtp-probe-token: <管理鍵>
 *
 * task: docs/tasks/P5-21.md
 * 決定: docs/DECISIONS.md #248
 * 手順: docs/runbook/smtp.md
 *
 * ── 鍵が無ければ 404 ────────────────────────────────────
 * `SMTP_PROBE_TOKEN` が設定されていて、同じ値が
 * `x-pk-smtp-probe-token` に載っているときだけ受ける。**既定は閉じている**
 * （`dev.ts` のシード経路・`platformBootstrap.ts` と同じ形 / #189・#245）。
 * 鍵は workflow が実行のたびに作って登録し、**終わったら消す**
 * （`.github/workflows/smtp-probe.yml` / #247 の形）。
 *
 * ── 環境で分岐しない ────────────────────────────────────
 * production でも（鍵があれば）確かめられる。**環境を増やしたときに
 * 書き漏らす形にしない**（`platformBootstrap.ts` と同じ判断）。
 *
 * ── 応答に何を載せないか ────────────────────────────────
 * ホスト名・利用者名・SMTP の応答文字列・秘密は**返さない。**
 * 返すのは 5 つの真偽値と、失敗した段階名だけ。
 */

import { Hono } from "hono";

import type { Env } from "@pk/db";

import { runSmtpProbe } from "../../../lib/mail/probe.js";

const smtpProbe = new Hono<{ Bindings: Env }>();

/** 長さを漏らさず比較する。**早期 return をしない**（`dev.ts` と同じ理由）。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * この要求が疎通確認を押してよいか。
 *
 * **鍵が置かれていない環境は 404。**「置かれていない」と「値が違う」を
 * 区別しない（経路の存在そのものを伏せる）。
 */
export function isSmtpProbeAllowed(
  env: Pick<Env, "SMTP_PROBE_TOKEN">,
  presentedToken: string | undefined,
): boolean {
  const expected = env.SMTP_PROBE_TOKEN;
  if (typeof expected !== "string" || expected.trim() === "") return false;
  if (typeof presentedToken !== "string" || presentedToken === "") return false;
  return timingSafeEqual(expected, presentedToken);
}

smtpProbe.post("/smtp-probe", async (c) => {
  if (!isSmtpProbeAllowed(c.env, c.req.header("x-pk-smtp-probe-token"))) {
    return c.json({ error: "Not Found" }, 404);
  }

  const report = await runSmtpProbe(c.env);
  // **真偽値と段階名だけ。** ホスト・利用者名・応答文字列を載せない。
  return c.json(report);
});

export default smtpProbe;
