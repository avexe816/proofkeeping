/**
 * 送信の口の検査（P5-21 / DECISIONS #248）。
 *
 * **鍵が無ければ 1 バイトも送らない**ことと、**結果に秘密・宛先・本文が
 * 載らない**ことを固定する。
 */

import { describe, expect, it, vi } from "vitest";

import type { Env } from "@pk/db";

import { canSendMail, sendMail } from "./send.js";
import type { SmtpSocket, SocketConnect } from "./smtp.js";

const NOW = new Date("2026-08-21T03:00:00.000Z");
const PASSWORD = "not-a-real-smtp-password";

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    SMTP_HOST: "smtp.example.invalid",
    SMTP_PORT: "465",
    SMTP_SECURE: "implicit",
    SMTP_USERNAME: "noreply@stek.ai",
    MAIL_FROM: "ProofKeeping <noreply@stek.ai>",
    SMTP_PASSWORD: PASSWORD,
    ...overrides,
  } as unknown as Env;
}

/** 送信が最後まで通る台本。 */
const HAPPY = [
  "220 ready\r\n",
  "250 AUTH LOGIN\r\n",
  "334 u\r\n",
  "334 p\r\n",
  "235 ok\r\n",
  "250 ok\r\n",
  "250 ok\r\n",
  "354 go\r\n",
  "250 queued\r\n",
  "221 bye\r\n",
];

function connectWith(script: string[]): { connect: SocketConnect; sent: () => string } {
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
  return { connect: () => socket, sent: () => written.join("") };
}

describe("canSendMail", () => {
  it("password / host / from が揃っていれば true", () => {
    expect(canSendMail(envWith())).toBe(true);
  });

  it("**password が空なら false**（送らない）", () => {
    expect(canSendMail(envWith({ SMTP_PASSWORD: "" }))).toBe(false);
    expect(canSendMail(envWith({ SMTP_PASSWORD: "   " }))).toBe(false);
  });

  it("host / from が空でも false", () => {
    expect(canSendMail(envWith({ SMTP_HOST: "" }))).toBe(false);
    expect(canSendMail(envWith({ MAIL_FROM: "" }))).toBe(false);
  });
});

describe("sendMail", () => {
  it("鍵が無ければ **接続そのものを行わない**", async () => {
    const connect = vi.fn<SocketConnect>();
    const result = await sendMail(
      envWith({ SMTP_PASSWORD: "" }),
      { to: "a@b.co", subject: "x", text: "y", now: NOW },
      connect,
    );
    expect(result).toEqual({ accepted: false, failedAt: "DISABLED", code: null });
    expect(connect).not.toHaveBeenCalled();
  });

  it("受理されたら `accepted: true`", async () => {
    const { connect } = connectWith(HAPPY);
    const result = await sendMail(
      envWith(),
      { to: "ops@example.invalid", subject: "件名", text: "本文", now: NOW },
      connect,
    );
    expect(result).toEqual({ accepted: true, failedAt: null, code: null });
  });

  it("エンベロープの差出人は表示名を含まない", async () => {
    const { connect, sent } = connectWith(HAPPY);
    await sendMail(envWith(), { to: "a@b.co", subject: "x", text: "y", now: NOW }, connect);
    expect(sent()).toContain("MAIL FROM:<noreply@stek.ai>\r\n");
    expect(sent()).not.toContain("MAIL FROM:<ProofKeeping");
  });

  it("**ヘッダに改行が混ざったら送らない**（`MIME` で止まる）", async () => {
    const connect = vi.fn<SocketConnect>();
    const result = await sendMail(
      envWith(),
      { to: "a@b.co\r\nBcc: attacker@evil.invalid", subject: "x", text: "y", now: NOW },
      connect,
    );
    expect(result).toEqual({ accepted: false, failedAt: "MIME", code: null });
    expect(connect).not.toHaveBeenCalled();
  });

  it("cc は `Cc` ヘッダにも `RCPT TO` にも入る", async () => {
    const { connect, sent } = connectWith([
      ...HAPPY.slice(0, 6),
      "250 ok\r\n",
      ...HAPPY.slice(6),
    ]);
    await sendMail(
      envWith(),
      { to: "a@x.invalid", cc: ["b@x.invalid"], subject: "x", text: "y", now: NOW },
      connect,
    );
    expect(sent()).toContain("RCPT TO:<a@x.invalid>\r\n");
    expect(sent()).toContain("RCPT TO:<b@x.invalid>\r\n");
  });

  it("**結果に password も宛先も本文も含めない**", async () => {
    const { connect } = connectWith([
      "220 ready\r\n",
      "250 AUTH LOGIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "535 bad credentials for noreply@stek.ai\r\n",
    ]);
    const result = await sendMail(
      envWith(),
      { to: "secret@example.invalid", subject: "秘密の件名", text: "秘密の本文", now: NOW },
      connect,
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain("secret@example.invalid");
    expect(json).not.toContain("秘密の本文");
    expect(json).not.toContain("bad credentials");
    expect(result).toEqual({ accepted: false, failedAt: "AUTH", code: 535 });
  });

  it("`SMTP_PORT` が読めなければ 465 を使う", async () => {
    const seen: { port?: number } = {};
    const { connect } = connectWith(HAPPY);
    const spy: SocketConnect = (address, options) => {
      seen.port = address.port;
      return connect(address, options);
    };
    await sendMail(
      envWith({ SMTP_PORT: "" }),
      { to: "a@b.co", subject: "x", text: "y", now: NOW },
      spy,
    );
    expect(seen.port).toBe(465);
  });

  it("`SMTP_SECURE` の既定は implicit（465）", async () => {
    const seen: { secure?: string } = {};
    const { connect } = connectWith(HAPPY);
    const spy: SocketConnect = (address, options) => {
      seen.secure = options.secureTransport;
      return connect(address, options);
    };
    await sendMail(
      envWith({ SMTP_SECURE: "" }),
      { to: "a@b.co", subject: "x", text: "y", now: NOW },
      spy,
    );
    expect(seen.secure).toBe("on");
  });
});
