/**
 * 送信経路の確認メール（P5-23 / **1 通だけ・固定の文面**）。
 *
 * task: docs/tasks/P5-23.md
 * 決定: docs/DECISIONS.md #249
 * 手順: docs/runbook/smtp.md §3
 *
 * ── なぜ PF-16 で試さないか ──────────────────────────────
 * 開通（PF-16）は**1 人目専用で押し直せない**。SMTP の認証がまだ確かめられて
 * いない段階であれを使うと、失敗したときに券だけが消費される。
 * **押し直してよい経路**を別に用意して、そちらで送信を確かめる。
 *
 * ── 何を送るか ──────────────────────────────────────────
 * **固定の日本語 1 通だけ。** 宛先は運用者が workflow の入力で指定する。
 * 開通リンク・token・顧客のデータ・帳票を**一切含めない**
 * （`tests/security/mailSecrets.spec.ts` が走査で固定）。
 *
 * ── 送信の実装を分岐させない ────────────────────────────
 * `sendMail()` をそのまま呼ぶ。**ここに SMTP の手順を書かない。**
 * 確認で通った道と本番で通る道が違ってしまっては、確認の意味が無い。
 */

import type { Env } from "@pk/db";

import { sendMail } from "./send.js";
import type { SocketConnect } from "./smtp.js";

/** 確認メールの件名。**固定**（入力で変えられない）。 */
export const SMTP_TEST_SUBJECT = "【ProofKeeping】送信経路の確認";

/**
 * 確認メールの本文。**固定**（入力で変えられない）。
 *
 * リンクを 1 本も置かない。受け取った人に操作を求めない。
 */
export const SMTP_TEST_BODY = [
  "これは ProofKeeping の送信経路の確認メールです。",
  "運用担当者が手で実行したときにだけ送られます。",
  "",
  "このメールに操作は要りません。",
  "心当たりが無い場合は、そのまま破棄してください。",
  "",
  "-- ",
  "ProofKeeping",
].join("\n");

/** 確認の結果。**この 3 つ以外を足さないこと。** */
export interface SmtpSendTestReport {
  /** SMTP が `DATA` を受理したか。**配信されたかは分からない**（#248）。 */
  accepted: boolean;
  /** 失敗した段階。成功なら `null`。 */
  failedAt: string | null;
  /** SMTP の応答コード（3 桁）。読めなければ `null`。 */
  code: number | null;
}

/**
 * 確認メールを 1 通送る。
 *
 * **宛先を戻り値に載せない。** 失敗の応答には宛先がそのまま echo される
 * ため（`550 <someone@example.com> unknown mailbox`）、返すのは成否・
 * 段階名・3 桁コードまでにする。
 *
 * `connect` を差し替えられるのは**テストのためだけ**。本番で渡さないこと。
 */
export async function runSmtpSendTest(
  env: Env,
  to: string,
  now: Date,
  connect?: SocketConnect,
): Promise<SmtpSendTestReport> {
  const result = await sendMail(
    env,
    { to, subject: SMTP_TEST_SUBJECT, text: SMTP_TEST_BODY, now },
    connect,
  );

  return { accepted: result.accepted, failedAt: result.failedAt, code: result.code };
}
