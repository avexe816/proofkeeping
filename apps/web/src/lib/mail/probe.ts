/**
 * SMTP の疎通確認（**メールを送らない**）。
 *
 * task: docs/tasks/P5-21.md
 * 決定: docs/DECISIONS.md #248
 * 手順: docs/runbook/smtp.md
 *
 * ── 何を確かめるか ──────────────────────────────────────
 * Cloudflare Workers から Lark の SMTP へ **TCP が出られるか**が最大の
 * 未知数（25 番は塞がれており、465 / 587 も出られない環境がある）。
 * 送信の実装へ進む前に、接続・TLS・greeting・`EHLO`・`AUTH` の広告までを
 * 確かめる。
 *
 * ── 送らない・認証もしない ──────────────────────────────
 * `MAIL FROM` 以降は実行しない。**`AUTH LOGIN` も試さない** —
 * 失敗回数を Lark 側に溜めないため、そして
 * **この経路が `SMTP_PASSWORD` を受け取らない**形にするため
 * （`probeSmtp()` の引数に password が無い）。
 *
 * ── 出すのは真偽値だけ ──────────────────────────────────
 * ホスト名も利用者名もサーバーの応答文字列も返さない。
 * 返すのは 5 つの `boolean` と、失敗した段階名だけ。
 */

import type { Env } from "@pk/db";

import { probeSmtp, type SmtpProbeResult, type SocketConnect } from "./smtp.js";

/** 疎通確認の応答。**この 6 つ以外を足さないこと。** */
export interface SmtpProbeReport {
  tcp: boolean;
  tls: boolean;
  greeting: boolean;
  ehlo: boolean;
  authAdvertised: boolean;
  /** 失敗した段階。すべて通れば `null`。 */
  failedAt: string | null;
}

/**
 * 設定を読んで疎通を確かめる。
 *
 * **`SMTP_PASSWORD` を読まない。** 認証を試さないので要らない。
 */
export async function runSmtpProbe(
  env: Pick<Env, "SMTP_HOST" | "SMTP_PORT" | "SMTP_SECURE" | "MAIL_FROM">,
  connect?: SocketConnect,
): Promise<SmtpProbeReport> {
  const port = Number.parseInt(env.SMTP_PORT, 10);
  const domain = env.MAIL_FROM.split("@")[1]?.replace(/>$/, "").trim() ?? "stek.ai";

  const result: SmtpProbeResult = await probeSmtp(
    {
      host: env.SMTP_HOST,
      port: Number.isFinite(port) && port > 0 ? port : 465,
      secure: env.SMTP_SECURE === "starttls" ? "starttls" : "implicit",
      ehloName: domain,
      username: undefined,
    },
    connect,
  );

  return {
    tcp: result.tcp,
    tls: result.tls,
    greeting: result.greeting,
    ehlo: result.ehlo,
    authAdvertised: result.authAdvertised,
    failedAt: result.failedAt,
  };
}
