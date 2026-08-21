/**
 * 検査用の偽 socket（P5-21）。**製品のコードから import しないこと。**
 *
 * `lib/mail/smtp.ts` は `SocketConnect` を差し替えられる形にしてある。
 * ここはその差し替え先で、**台本どおりに応答し、送られたコマンドを溜める。**
 * 本物の TCP は開かない。
 *
 * 置き場所を `tests/` ではなく実装の隣にしたのは、`apps/web` の spec が
 * 相対 import で読むため（`tests/fixtures` を読んでいる spec が無い）。
 * **`console` を持たない**のは実装側と同じ約束（`mailSecrets.spec.ts`）。
 */

import type { SmtpSocket, SocketConnect } from "./smtp.js";

/** 台本を与えて `connect` を作る。`sent()` で送られたものを読む。 */
export function fakeSmtpConnect(script: readonly string[]): {
  connect: SocketConnect;
  sent: () => string[];
  sentText: () => string;
} {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const written: string[] = [];
  let step = 0;

  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      const line = script[step];
      step += 1;
      if (line === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(line));
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(decoder.decode(chunk));
    },
  });

  const socket: SmtpSocket = {
    readable,
    writable,
    close: () => Promise.resolve(),
    startTls: () => socket,
  };

  return {
    connect: () => socket,
    sent: () => written,
    sentText: () => written.join(""),
  };
}

/**
 * 送られた MIME から**本文を読み直す**（検査用）。
 *
 * 本文は base64 なので、書かれたバイト列をそのまま `includes()` しても
 * リンクは見つからない。**`atob()` だけでも足りない**（返るのは latin-1
 * として並べた文字列で、日本語が化ける）。
 */
export function decodeSentMailBody(written: readonly string[]): string {
  const mime = written.find((chunk) => chunk.includes("MIME-Version:")) ?? "";
  const body = mime.split("\r\n\r\n")[1] ?? "";
  const binary = atob(body.replace(/\r\n/g, "").trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 送信が最後まで通る台本（1 宛先）。 */
export const SMTP_HAPPY_PATH: readonly string[] = [
  "220 ready\r\n",
  "250 AUTH LOGIN\r\n",
  "334 dXNlcm5hbWU6\r\n",
  "334 cGFzc3dvcmQ6\r\n",
  "235 authenticated\r\n",
  "250 sender ok\r\n",
  "250 recipient ok\r\n",
  "354 go ahead\r\n",
  "250 queued\r\n",
  "221 bye\r\n",
];

/** 検査で使う SMTP の設定（`env` に混ぜる）。**実在しないホスト。** */
export const FAKE_SMTP_ENV = {
  SMTP_HOST: "smtp.example.invalid",
  SMTP_PORT: "465",
  SMTP_SECURE: "implicit",
  SMTP_USERNAME: "noreply@example.invalid",
  MAIL_FROM: "ProofKeeping <noreply@example.invalid>",
  SMTP_PASSWORD: "test-only-password",
} as const;
