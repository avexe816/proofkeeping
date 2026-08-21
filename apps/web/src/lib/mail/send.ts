/**
 * メール送信の**唯一の口**（Lark Mail SMTP）。
 *
 * task: docs/tasks/P5-21.md
 * 決定: docs/DECISIONS.md #248
 *
 * ── 3 経路がここへ集まる ────────────────────────────────
 *   - `lib/platform/bootstrapMail.ts`  運営の開通リンク（PF-16）
 *   - `consumers/notification.ts`      帳票の送付（P5-07 / P5-10）
 *   - `consumers/notify.ts`            業務通知（P6-08）
 *
 * 以前は 3 か所が別々に Resend を `fetch` していた。**送り先を変えるたび
 * 3 か所を直す形にしない。**
 *
 * ── 鍵が無ければ送らない（DECISIONS #188 を踏襲）────────
 * `SMTP_PASSWORD` が未設定・空白なら **接続そのものを行わない。**
 * 環境名で分岐しない — 環境を増やすたびに条件が増え、書き漏らした環境から
 * 実送信が漏れる。「鍵を置かない = 送らない」を保つ。
 *
 * ── 返すのは成否と段階だけ ──────────────────────────────
 * 宛先・本文・SMTP の応答文字列を**戻り値にも例外にも載せない。**
 * ここも `console` を呼ばない（`tests/security/mailSecrets.spec.ts` が走査）。
 */

import type { Env } from "@pk/db";

import { buildMimeMessage, extractAddress } from "./mime.js";
import { sendViaSmtp, type SmtpOutcome, type SmtpStage, type SocketConnect } from "./smtp.js";

/** 送る 1 通。**添付は扱わない**（第一段階）。 */
export interface SendMailInput {
  to: string;
  /** 同報。**`Cc` ヘッダにも `RCPT TO` にも入る。** */
  cc?: readonly string[] | undefined;
  subject: string;
  text: string;
  /** 現在時刻。**`Date.now()` を直接呼ばない**（CLAUDE.md §5）。 */
  now: Date;
  /** `Message-ID` の左側。省略時は乱数。 */
  messageIdLocalPart?: string | undefined;
}

/**
 * 送信の結果。
 *
 * `accepted` は **Lark SMTP が `DATA` を受理した**という意味しか持たない。
 * **配信・開封・バウンスは分からない**（#248 / OPEN_QUESTIONS #118）。
 */
export interface SendMailResult {
  accepted: boolean;
  /** 失敗した段階。成功なら `null`。**応答の全文は持たない。** */
  failedAt: SmtpStage | "DISABLED" | "MIME" | null;
  /**
   * SMTP の応答コード（3 桁）。読めなければ `null`。
   *
   * **持つのは数字だけ。** 応答の文言は載せない — 拒否のとき宛先が
   * そのまま echo されるため（`550 <someone@example.com> unknown mailbox`）。
   * 送れないときに「認証で断られた（535）」と「宛先が無い（550）」を
   * 運用者が区別できるだけの手掛かりに留める（P5-23）。
   */
  code: number | null;
}

/** SMTP の設定が揃っているか。**password が無ければ送らない。** */
export function canSendMail(env: Pick<Env, "SMTP_PASSWORD" | "SMTP_HOST" | "MAIL_FROM">): boolean {
  const filled = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";
  return filled(env.SMTP_PASSWORD) && filled(env.SMTP_HOST) && filled(env.MAIL_FROM);
}

/** `SMTP_SECURE` を読む。**未設定は implicit**（465 が第一候補 / #248）。 */
function readSecure(value: string | undefined): "implicit" | "starttls" {
  return value === "starttls" ? "starttls" : "implicit";
}

/** `SMTP_PORT` を読む。**読めなければ 465。** */
function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isFinite(port) && port > 0 ? port : 465;
}

/** `Message-ID` の左側。 */
function randomLocalPart(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `pk-${hex}`;
}

/**
 * 1 通送る。
 *
 * `connect` を差し替えられるのは**テストのためだけ**。本番で渡さないこと。
 */
export async function sendMail(
  env: Env,
  input: SendMailInput,
  connect?: SocketConnect,
): Promise<SendMailResult> {
  if (!canSendMail(env)) return { accepted: false, failedAt: "DISABLED", code: null };

  const from = env.MAIL_FROM;
  const cc = (input.cc ?? []).map((value) => value.trim()).filter((value) => value !== "");
  const built = buildMimeMessage({
    from,
    to: input.to,
    cc,
    subject: input.subject,
    text: input.text,
    now: input.now,
    messageIdLocalPart: input.messageIdLocalPart ?? randomLocalPart(),
  });
  // **組み立てに失敗したら送らない**（ヘッダに改行が混ざっていた等）。
  if (!built.ok) return { accepted: false, failedAt: "MIME", code: null };

  const envelopeFrom = extractAddress(from);
  const outcome: SmtpOutcome = await sendViaSmtp(
    {
      host: env.SMTP_HOST,
      port: readPort(env.SMTP_PORT),
      secure: readSecure(env.SMTP_SECURE),
      username: env.SMTP_USERNAME,
      password: env.SMTP_PASSWORD,
      // **`EHLO` に載せるのは差出人のドメイン。** 受信側の逆引きに使われる。
      ehloName: envelopeFrom.split("@")[1] ?? "stek.ai",
    },
    { envelopeFrom, recipients: [input.to.trim(), ...cc], data: built.data },
    connect,
  );

  return { accepted: outcome.ok, failedAt: outcome.ok ? null : outcome.failedAt, code: outcome.code };
}
