/**
 * 送信経路の確認の口（P5-23）。**固定の文面を 1 通だけ送る。**
 *
 *   POST /api/v1/dev/smtp-send-test
 *   header: x-pk-smtp-send-test-token: <管理鍵>
 *   body:   { "to": "<宛先>" }
 *
 * task: docs/tasks/P5-23.md
 * 決定: docs/DECISIONS.md #249
 * 手順: docs/runbook/smtp.md §3
 *
 * ── 鍵が無ければ 404 ────────────────────────────────────
 * `SMTP_SEND_TEST_TOKEN` が設定されていて、同じ値が
 * `x-pk-smtp-send-test-token` に載っているときだけ受ける。**既定は
 * 閉じている**（`dev.ts` のシード経路・`smtpProbe.ts` と同じ形 /
 * #189・#245・#248）。鍵は workflow が実行のたびに作って登録し、
 * **終わったら消す**（`.github/workflows/smtp-send-test.yml` / #247 の形）。
 *
 * ── 宛先はコードに埋めない ──────────────────────────────
 * 送り先は**実行のたびに人が指定する**。既定値を持たせない — 既定があると
 * 押し間違いで意図しない相手へ送れてしまう。
 *
 * ── 応答に何を載せないか ────────────────────────────────
 * **宛先・本文・SMTP の応答文字列・秘密は返さない。** 返すのは成否・
 * 失敗した段階名・3 桁の応答コードだけ（`lib/mail/sendTest.ts`）。
 */

import { Hono } from "hono";

import type { Env } from "@pk/db";

import { runSmtpSendTest } from "../../../lib/mail/sendTest.js";

const smtpSendTest = new Hono<{ Bindings: Env }>();

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
 * この要求が確認メールを送ってよいか。
 *
 * **鍵が置かれていない環境は 404。**「置かれていない」と「値が違う」を
 * 区別しない（経路の存在そのものを伏せる）。
 */
export function isSmtpSendTestAllowed(
  env: Pick<Env, "SMTP_SEND_TEST_TOKEN">,
  presentedToken: string | undefined,
): boolean {
  const expected = env.SMTP_SEND_TEST_TOKEN;
  if (typeof expected !== "string" || expected.trim() === "") return false;
  if (typeof presentedToken !== "string" || presentedToken === "") return false;
  return timingSafeEqual(expected, presentedToken);
}

/**
 * 宛先として受け付けられる形か。
 *
 * **深く検証しない。** ここで弾きたいのは空・改行（ヘッダインジェクション）・
 * 明らかにアドレスでないものだけで、通ったかどうかは SMTP の応答が答える。
 * 改行は `mime.ts` でも弾かれるが、**送る前に止める**方が短い。
 */
export function isAcceptableRecipient(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 254) return false;
  if (/[\r\n]/.test(trimmed)) return false;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
}

smtpSendTest.post("/smtp-send-test", async (c) => {
  if (!isSmtpSendTestAllowed(c.env, c.req.header("x-pk-smtp-send-test-token"))) {
    return c.json({ error: "Not Found" }, 404);
  }

  const body: unknown = await c.req.json().catch(() => ({}));
  const to =
    typeof body === "object" && body !== null && "to" in body
      ? (body as Record<string, unknown>).to
      : undefined;

  // **宛先を応答に echo しない。** 形が違うことだけを伝える。
  if (!isAcceptableRecipient(to)) return c.json({ error: "INVALID_RECIPIENT" }, 400);

  const report = await runSmtpSendTest(c.env, to.trim(), new Date());
  // **成否・段階名・3 桁コードだけ。** 宛先も応答文字列も載せない。
  return c.json(report);
});

export default smtpSendTest;
