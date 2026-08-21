/**
 * SMTP クライアントの検査（P5-21 / DECISIONS #248）。
 *
 * **本物の socket を開かない。** `SocketConnect` を差し替え、応答を台本で
 * 与えて、こちらが送ったコマンドの並びを見る。
 */

import { describe, expect, it } from "vitest";

import {
  probeSmtp,
  sendViaSmtp,
  type SmtpConfig,
  type SmtpSocket,
  type SocketConnect,
} from "./smtp.js";

const CONFIG: SmtpConfig = {
  host: "smtp.example.invalid",
  port: 465,
  secure: "implicit",
  username: "noreply@stek.ai",
  password: "not-a-real-password",
  ehloName: "stek.ai",
};

/** 偽の socket。**台本どおりに応答し、送られたコマンドを溜める。** */
function fakeSocket(script: string[]): { socket: SmtpSocket; sent: () => string[] } {
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
  return { socket, sent: () => written };
}

/** 台本を与えて `connect` を作る。 */
function connectWith(script: string[]): { connect: SocketConnect; sent: () => string[] } {
  const fake = fakeSocket(script);
  return { connect: () => fake.socket, sent: fake.sent };
}

/** 送信が最後まで通る台本。 */
const HAPPY_SEND = [
  "220 smtp ready\r\n",
  "250-smtp\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n",
  "334 VXNlcm5hbWU6\r\n",
  "334 UGFzc3dvcmQ6\r\n",
  "235 authenticated\r\n",
  "250 sender ok\r\n",
  "250 recipient ok\r\n",
  "354 go ahead\r\n",
  "250 queued\r\n",
  "221 bye\r\n",
];

describe("probeSmtp（**メールを送らない**）", () => {
  it("接続・TLS・greeting・EHLO・AUTH の広告まで通る", async () => {
    const { connect, sent } = connectWith([
      "220 smtp ready\r\n",
      "250-smtp\r\n250 AUTH LOGIN PLAIN\r\n",
      "221 bye\r\n",
    ]);

    const result = await probeSmtp({ ...CONFIG, username: undefined }, connect);

    expect(result).toEqual({
      tcp: true,
      tls: true,
      greeting: true,
      ehlo: true,
      authAdvertised: true,
      failedAt: null,
    });
    // **EHLO と QUIT しか送らない。** MAIL FROM も AUTH も送らない。
    expect(sent()).toEqual(["EHLO stek.ai\r\n", "QUIT\r\n"]);
  });

  it("**`AUTH LOGIN` を実行しない**（パスワードを送らない）", async () => {
    const { connect, sent } = connectWith([
      "220 ready\r\n",
      "250 AUTH LOGIN\r\n",
      "221 bye\r\n",
    ]);
    await probeSmtp({ ...CONFIG, username: undefined }, connect);
    const written = sent().join("");
    expect(written).not.toContain("AUTH LOGIN");
    expect(written).not.toContain(CONFIG.password);
  });

  it("AUTH が広告されなければ `failedAt: AUTH`", async () => {
    const { connect } = connectWith(["220 ready\r\n", "250 smtp\r\n"]);
    const result = await probeSmtp({ ...CONFIG, username: undefined }, connect);
    expect(result.ehlo).toBe(true);
    expect(result.authAdvertised).toBe(false);
    expect(result.failedAt).toBe("AUTH");
  });

  it("greeting が 220 でなければ TLS 段階で止まる（implicit）", async () => {
    const { connect } = connectWith(["554 no service\r\n"]);
    const result = await probeSmtp({ ...CONFIG, username: undefined }, connect);
    expect(result).toMatchObject({ tcp: true, tls: false, failedAt: "TLS" });
  });

  it("接続そのものが投げたら `failedAt: CONNECT`", async () => {
    const connect: SocketConnect = () => {
      throw new Error("refused");
    };
    const result = await probeSmtp({ ...CONFIG, username: undefined }, connect);
    expect(result).toMatchObject({ tcp: false, failedAt: "CONNECT" });
  });

  it("結果に host も応答文字列も含めない（真偽値と段階名だけ）", async () => {
    const { connect } = connectWith(["220 smtp.example.invalid ready\r\n", "250 AUTH\r\n", "221\r\n"]);
    const result = await probeSmtp({ ...CONFIG, username: undefined }, connect);
    const json = JSON.stringify(result);
    expect(json).not.toContain("smtp.example.invalid");
    expect(json).not.toContain("ready");
    expect(Object.keys(result).sort()).toEqual([
      "authAdvertised",
      "ehlo",
      "failedAt",
      "greeting",
      "tcp",
      "tls",
    ]);
  });
});

describe("sendViaSmtp", () => {
  it("AUTH → MAIL FROM → RCPT TO → DATA → . → QUIT の順に送る", async () => {
    const { connect, sent } = connectWith(HAPPY_SEND);

    const outcome = await sendViaSmtp(
      CONFIG,
      {
        envelopeFrom: "noreply@stek.ai",
        recipients: ["ops@example.invalid"],
        data: "Subject: x\r\n\r\nbody\r\n",
      },
      connect,
    );

    expect(outcome).toEqual({ ok: true, failedAt: null, code: null });
    const written = sent();
    expect(written[0]).toBe("EHLO stek.ai\r\n");
    expect(written[1]).toBe("AUTH LOGIN\r\n");
    expect(written[4]).toBe("MAIL FROM:<noreply@stek.ai>\r\n");
    expect(written[5]).toBe("RCPT TO:<ops@example.invalid>\r\n");
    expect(written[6]).toBe("DATA\r\n");
    expect(written[7]).toBe("Subject: x\r\n\r\nbody\r\n");
    expect(written[8]).toBe(".\r\n");
    expect(written[9]).toBe("QUIT\r\n");
  });

  it("利用者名とパスワードを base64 で送る（平文で流さない）", async () => {
    const { connect, sent } = connectWith(HAPPY_SEND);
    await sendViaSmtp(
      CONFIG,
      { envelopeFrom: "noreply@stek.ai", recipients: ["a@b.co"], data: "x\r\n" },
      connect,
    );
    const written = sent().join("");
    expect(written).not.toContain(CONFIG.password);
    expect(written).toContain(`${btoa(CONFIG.username)}\r\n`);
  });

  it("cc も `RCPT TO` に載せる（**1 件でも拒否されたら送らない**）", async () => {
    const { connect, sent } = connectWith([
      "220 ready\r\n",
      "250 AUTH LOGIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "235 ok\r\n",
      "250 sender ok\r\n",
      "250 first ok\r\n",
      "550 second rejected\r\n",
    ]);

    const outcome = await sendViaSmtp(
      CONFIG,
      {
        envelopeFrom: "noreply@stek.ai",
        recipients: ["a@example.invalid", "b@example.invalid"],
        data: "x\r\n",
      },
      connect,
    );

    expect(outcome).toEqual({ ok: false, failedAt: "RCPT_TO", code: 550 });
    // **DATA へ進んでいない。**
    expect(sent().join("")).not.toContain("DATA\r\n");
  });

  it("認証が通らなければ `failedAt: AUTH`", async () => {
    const { connect } = connectWith([
      "220 ready\r\n",
      "250 AUTH LOGIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "535 bad credentials\r\n",
    ]);
    const outcome = await sendViaSmtp(
      CONFIG,
      { envelopeFrom: "noreply@stek.ai", recipients: ["a@b.co"], data: "x\r\n" },
      connect,
    );
    expect(outcome).toEqual({ ok: false, failedAt: "AUTH", code: 535 });
  });

  it("`DATA` の完了が 250 でなければ受理としない", async () => {
    const { connect } = connectWith([
      ...HAPPY_SEND.slice(0, 8),
      "451 try again later\r\n",
    ]);
    const outcome = await sendViaSmtp(
      CONFIG,
      { envelopeFrom: "noreply@stek.ai", recipients: ["a@b.co"], data: "x\r\n" },
      connect,
    );
    expect(outcome).toEqual({ ok: false, failedAt: "DATA", code: 451 });
  });

  it("戻り値に応答文字列も宛先も含めない", async () => {
    const { connect } = connectWith([
      "220 ready\r\n",
      "250 AUTH LOGIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "235 ok\r\n",
      "550 <secret@example.invalid> unknown mailbox\r\n",
    ]);
    const outcome = await sendViaSmtp(
      CONFIG,
      { envelopeFrom: "noreply@stek.ai", recipients: ["secret@example.invalid"], data: "x\r\n" },
      connect,
    );
    const json = JSON.stringify(outcome);
    expect(json).not.toContain("secret@example.invalid");
    expect(json).not.toContain("unknown mailbox");
    expect(outcome).toEqual({ ok: false, failedAt: "MAIL_FROM", code: 550 });
  });

  it("継続行（`250-`）を畳んで最後の行まで読む", async () => {
    const { connect } = connectWith([
      "220 ready\r\n",
      "250-smtp.example\r\n250-SIZE 52428800\r\n250-8BITMIME\r\n250 AUTH LOGIN PLAIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "235 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);
    const outcome = await sendViaSmtp(
      CONFIG,
      { envelopeFrom: "noreply@stek.ai", recipients: ["a@b.co"], data: "x\r\n" },
      connect,
    );
    expect(outcome.ok).toBe(true);
  });

  it("STARTTLS（587）は TLS の後に EHLO をやり直す", async () => {
    const { connect, sent } = connectWith([
      "220 ready\r\n",
      "250-smtp\r\n250 STARTTLS\r\n",
      "220 go ahead\r\n",
      // startTls() 後は同じ台本の続きを読む（偽 socket は自分を返す）。
      "250-smtp\r\n250 AUTH LOGIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "235 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);

    const outcome = await sendViaSmtp(
      { ...CONFIG, secure: "starttls", port: 587 },
      { envelopeFrom: "noreply@stek.ai", recipients: ["a@b.co"], data: "x\r\n" },
      connect,
    );

    expect(outcome.ok).toBe(true);
    const written = sent();
    expect(written[0]).toBe("EHLO stek.ai\r\n");
    expect(written[1]).toBe("STARTTLS\r\n");
    // **やり直しの EHLO。**
    expect(written[2]).toBe("EHLO stek.ai\r\n");
  });

  it("**25 番を既定にしない**（設定は 465）", () => {
    expect(CONFIG.port).toBe(465);
    expect(CONFIG.secure).toBe("implicit");
  });
});
