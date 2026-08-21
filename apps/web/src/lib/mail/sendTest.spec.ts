/**
 * 送信経路の確認の検査（P5-23 / DECISIONS #249）。
 *
 * **本物の socket を開かない。** 偽 socket に台本を与えて、送られた
 * MIME と戻り値を見る。
 */

import { describe, expect, it, vi } from "vitest";

import type { Env } from "@pk/db";

import { decodeSentMailBody, fakeSmtpConnect, SMTP_HAPPY_PATH } from "./fakeSocket.js";
import { runSmtpSendTest, SMTP_TEST_BODY, SMTP_TEST_SUBJECT } from "./sendTest.js";
import type { SocketConnect } from "./smtp.js";

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

describe("固定の文面", () => {
  it("件名も本文も入力で変えられない（定数）", () => {
    expect(SMTP_TEST_SUBJECT).toBe("【ProofKeeping】送信経路の確認");
    expect(SMTP_TEST_BODY).toContain("送信経路の確認メールです");
  });

  it("**リンクを 1 本も置かない**（開通リンクと取り違えさせない）", () => {
    expect(SMTP_TEST_BODY).not.toMatch(/https?:\/\//);
  });

  it("token めいた長い英数字の並びを置かない", () => {
    expect(SMTP_TEST_BODY).not.toMatch(/[A-Za-z0-9_-]{24,}/);
  });
});

describe("runSmtpSendTest", () => {
  it("固定の件名と本文で 1 通送る", async () => {
    const fake = fakeSmtpConnect(SMTP_HAPPY_PATH);
    const report = await runSmtpSendTest(
      envWith(),
      "ops@example.invalid",
      NOW,
      fake.connect,
    );

    expect(report).toEqual({ accepted: true, failedAt: null, code: null });
    // **宛先は 1 件だけ。**
    const written = fake.sentText();
    expect(written).toContain("RCPT TO:<ops@example.invalid>\r\n");
    expect(written.match(/RCPT TO:/g)).toHaveLength(1);
    // 本文の改行は CRLF へ揃えられる（RFC 5322 / `mime.ts`）。
    expect(decodeSentMailBody(fake.sent())).toBe(SMTP_TEST_BODY.replace(/\n/g, "\r\n"));
  });

  it("**鍵が無ければ接続そのものを行わない**（`DISABLED`）", async () => {
    const connect = vi.fn<SocketConnect>();
    const report = await runSmtpSendTest(
      envWith({ SMTP_PASSWORD: "" }),
      "ops@example.invalid",
      NOW,
      connect,
    );
    expect(report).toEqual({ accepted: false, failedAt: "DISABLED", code: null });
    expect(connect).not.toHaveBeenCalled();
  });

  it("認証で断られたら段階名と 3 桁コードを返す", async () => {
    const fake = fakeSmtpConnect([
      "220 ready\r\n",
      "250 AUTH LOGIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "535 bad credentials\r\n",
    ]);
    const report = await runSmtpSendTest(envWith(), "ops@example.invalid", NOW, fake.connect);
    expect(report).toEqual({ accepted: false, failedAt: "AUTH", code: 535 });
  });

  it("**戻り値に宛先も応答文字列も password も載せない**", async () => {
    const fake = fakeSmtpConnect([
      "220 ready\r\n",
      "250 AUTH LOGIN\r\n",
      "334 u\r\n",
      "334 p\r\n",
      "235 ok\r\n",
      "250 sender ok\r\n",
      "550 <secret@example.invalid> unknown mailbox\r\n",
    ]);
    const report = await runSmtpSendTest(envWith(), "secret@example.invalid", NOW, fake.connect);

    const json = JSON.stringify(report);
    expect(json).not.toContain("secret@example.invalid");
    expect(json).not.toContain("unknown mailbox");
    expect(json).not.toContain(PASSWORD);
    expect(report).toEqual({ accepted: false, failedAt: "RCPT_TO", code: 550 });
  });

  it("**戻り値の鍵は 3 つだけ**（増やすときは理由を書くこと）", async () => {
    const fake = fakeSmtpConnect(SMTP_HAPPY_PATH);
    const report = await runSmtpSendTest(envWith(), "a@b.co", NOW, fake.connect);
    expect(Object.keys(report).sort()).toEqual(["accepted", "code", "failedAt"]);
  });

  it("宛先に改行が混ざったら送らない（`MIME` で止まる）", async () => {
    const connect = vi.fn<SocketConnect>();
    const report = await runSmtpSendTest(
      envWith(),
      "a@b.co\r\nBcc: attacker@evil.invalid",
      NOW,
      connect,
    );
    expect(report).toEqual({ accepted: false, failedAt: "MIME", code: null });
    expect(connect).not.toHaveBeenCalled();
  });
});
