/**
 * メール 1 通の組み立て（RFC 5322）。**純粋関数・依存ゼロ。**
 *
 * task: docs/tasks/P5-21.md（Resend → Lark SMTP)
 * 決定: docs/DECISIONS.md #248
 *
 * ── ここが「本文を作る唯一の場所」────────────────────────
 * Resend は JSON を投げれば済んだが、SMTP は**こちらがメールそのものを
 * 組み立てる。** ヘッダの改行 1 つで別のメールを差し込めるので、
 * 組み立てを 1 か所に閉じ、**入口で改行を弾く。**
 *
 * ── ログを持たない ──────────────────────────────────────
 * この層は `console` を呼ばない。宛先も本文も引数として通り抜けるだけで、
 * **どこにも残さない**（`tests/security/mailSecrets.spec.ts` が走査する）。
 *
 * ── 日本語 ──────────────────────────────────────────────
 * 件名は RFC 2047 の `=?UTF-8?B?…?=`、本文は `Content-Type: text/plain;
 * charset="UTF-8"` + `Content-Transfer-Encoding: base64`。
 * **生の UTF-8 を 8bit で流さない**（SMTPUTF8 を広告しないサーバーが
 * 化けさせるため）。
 */

/** ヘッダに入れてはいけない文字（CR / LF）。**1 つでもあれば組み立てない。** */
const FORBIDDEN_IN_HEADER = /[\r\n]/;

/** 組み立てる 1 通ぶん。**添付は扱わない**（第一段階 / #248）。 */
export interface MailMessage {
  /** 差出人。`ProofKeeping <noreply@stek.ai>` の形も受ける。 */
  from: string;
  /** 宛先。 */
  to: string;
  /** 同報。空配列なら `Cc` ヘッダを出さない。 */
  cc?: readonly string[] | undefined;
  subject: string;
  /** 本文（テキスト）。改行は `\n` で渡してよい。 */
  text: string;
  /** `Date` ヘッダに使う時刻。**`Date.now()` を呼ばない**（CLAUDE.md §5）。 */
  now: Date;
  /** `Message-ID` の左側。呼び出し側が決める（テストを決定的にするため）。 */
  messageIdLocalPart: string;
}

/** 組み立てに失敗した理由。**値そのものを含めない。** */
export type MimeError = "HEADER_INJECTION" | "EMPTY_RECIPIENT" | "EMPTY_SENDER";

export type BuildMimeResult =
  | { ok: true; data: string }
  | { ok: false; reason: MimeError };

/** UTF-8 の文字列を base64 にする。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 件名を RFC 2047 で包む。**ASCII だけなら包まない**（読みやすさのため）。
 *
 * 分割はしない。長い件名は 1 つの encoded-word になるが、実務上の
 * 件名の長さ（数十文字）では問題にならない。
 */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${toBase64(subject)}?=`;
}

/** base64 を 76 文字ごとに折る（RFC 2045）。 */
function wrapBase64(encoded: string): string {
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join("\r\n");
}

/**
 * `From: ProofKeeping <noreply@stek.ai>` から `noreply@stek.ai` を取り出す。
 *
 * **`MAIL FROM` に使う値**（エンベロープ）。表示名は載せない。
 * `<>` が無ければ全体をアドレスとして扱う。
 */
export function extractAddress(mailbox: string): string {
  const start = mailbox.lastIndexOf("<");
  const end = mailbox.lastIndexOf(">");
  if (start !== -1 && end > start) return mailbox.slice(start + 1, end).trim();
  return mailbox.trim();
}

/**
 * メール 1 通を組み立てる。
 *
 * **ヘッダに使う値へ改行が混ざっていたら組み立てない**（`HEADER_INJECTION`）。
 * 本文の改行は正規化して CRLF にする（SMTP の行終端）。
 */
export function buildMimeMessage(message: MailMessage): BuildMimeResult {
  const from = message.from.trim();
  const to = message.to.trim();
  if (from === "") return { ok: false, reason: "EMPTY_SENDER" };
  if (to === "") return { ok: false, reason: "EMPTY_RECIPIENT" };

  const cc = (message.cc ?? []).map((value) => value.trim()).filter((value) => value !== "");
  for (const value of [from, to, message.subject, message.messageIdLocalPart, ...cc]) {
    if (FORBIDDEN_IN_HEADER.test(value)) return { ok: false, reason: "HEADER_INJECTION" };
  }

  const domain = extractAddress(from).split("@")[1] ?? "localhost";
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc.length === 0 ? [] : [`Cc: ${cc.join(", ")}`]),
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${formatRfc5322Date(message.now)}`,
    `Message-ID: <${message.messageIdLocalPart}@${domain}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    // 自動返信を呼ばない（不在通知が運営の受信箱へ溜まるのを避ける）。
    "Auto-Submitted: auto-generated",
  ];

  // 本文の改行を CRLF へ揃えてから base64。**base64 なのでドットスタッフィングは
  // 不要**（行頭に `.` が現れない）。
  const body = wrapBase64(toBase64(message.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")));

  return { ok: true, data: `${headers.join("\r\n")}\r\n\r\n${body}\r\n` };
}

/** 曜日と月の英語表記（RFC 5322 は英語固定）。 */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * `Date` ヘッダ（RFC 5322）。**日本時間で出す**（受信箱の並びが業務時間と揃う）。
 *
 * `toUTCString()` を使わないのは、あれが `GMT` を出す形で RFC 5322 の
 * `+0900` 形式と違うため。
 */
export function formatRfc5322Date(at: Date): string {
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  const day = DAYS[jst.getUTCDay()] ?? "Sun";
  const month = MONTHS[jst.getUTCMonth()] ?? "Jan";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${day}, ${pad(jst.getUTCDate())} ${month} ${String(jst.getUTCFullYear())} ` +
    `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())} +0900`
  );
}
