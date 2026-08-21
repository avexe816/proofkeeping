/**
 * メールの組み立ての検査（P5-21 / DECISIONS #248）。
 *
 * **ヘッダインジェクションを止めること**が主眼。改行が 1 つ通れば、
 * 宛先を足したメールを差し込める。
 */

import { describe, expect, it } from "vitest";

import { buildMimeMessage, encodeSubject, extractAddress, formatRfc5322Date } from "./mime.js";

const NOW = new Date("2026-08-21T03:00:00.000Z"); // JST 12:00

/**
 * base64 を UTF-8 として読み直す。
 *
 * **`atob()` だけでは足りない。** あれが返すのはバイト列を latin-1 として
 * 並べた文字列で、日本語は化ける（テスト側の落とし穴）。
 */
function decodeBase64Utf8(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const BASE = {
  from: "ProofKeeping <noreply@stek.ai>",
  to: "ops@example.invalid",
  subject: "テスト",
  text: "本文",
  now: NOW,
  messageIdLocalPart: "pk-test",
} as const;

describe("buildMimeMessage", () => {
  it("ヘッダと本文を CRLF 区切りで組み立てる", () => {
    const built = buildMimeMessage(BASE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.data).toContain("From: ProofKeeping <noreply@stek.ai>\r\n");
    expect(built.data).toContain("To: ops@example.invalid\r\n");
    expect(built.data).toContain("MIME-Version: 1.0\r\n");
    expect(built.data).toContain('Content-Type: text/plain; charset="UTF-8"\r\n');
    expect(built.data).toContain("Content-Transfer-Encoding: base64\r\n");
    expect(built.data).toContain("Message-ID: <pk-test@stek.ai>\r\n");
    // ヘッダと本文は空行で区切る。
    expect(built.data).toContain("\r\n\r\n");
  });

  it("本文を base64 にする（生の UTF-8 を流さない）", () => {
    const built = buildMimeMessage({ ...BASE, text: "日本語の本文" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data).not.toContain("日本語の本文");
    const body = built.data.split("\r\n\r\n")[1] ?? "";
    expect(decodeBase64Utf8(body.trim())).toContain("日本語の本文");
  });

  // ── ヘッダインジェクション ──────────────────────────────

  it("**宛先に改行が混ざったら組み立てない**", () => {
    const built = buildMimeMessage({ ...BASE, to: "a@b.co\r\nBcc: attacker@evil.invalid" });
    expect(built).toEqual({ ok: false, reason: "HEADER_INJECTION" });
  });

  it("件名に改行が混ざったら組み立てない", () => {
    const built = buildMimeMessage({ ...BASE, subject: "x\nBcc: attacker@evil.invalid" });
    expect(built).toEqual({ ok: false, reason: "HEADER_INJECTION" });
  });

  it("差出人・cc に改行が混ざったら組み立てない", () => {
    expect(buildMimeMessage({ ...BASE, from: "a@b.co\r\nX: y" })).toEqual({
      ok: false,
      reason: "HEADER_INJECTION",
    });
    expect(buildMimeMessage({ ...BASE, cc: ["c@d.co\r\nBcc: e@f.co"] })).toEqual({
      ok: false,
      reason: "HEADER_INJECTION",
    });
  });

  it("宛先・差出人が空なら組み立てない", () => {
    expect(buildMimeMessage({ ...BASE, to: "   " })).toEqual({
      ok: false,
      reason: "EMPTY_RECIPIENT",
    });
    expect(buildMimeMessage({ ...BASE, from: "" })).toEqual({ ok: false, reason: "EMPTY_SENDER" });
  });

  it("cc があれば `Cc` ヘッダを出し、無ければ出さない", () => {
    const withCc = buildMimeMessage({ ...BASE, cc: ["a@x.invalid", "b@x.invalid"] });
    expect(withCc.ok).toBe(true);
    if (withCc.ok) expect(withCc.data).toContain("Cc: a@x.invalid, b@x.invalid\r\n");

    const without = buildMimeMessage({ ...BASE, cc: [] });
    expect(without.ok).toBe(true);
    if (without.ok) expect(without.data).not.toContain("Cc:");
  });

  it("自動返信を呼ばない（`Auto-Submitted`）", () => {
    const built = buildMimeMessage(BASE);
    if (built.ok) expect(built.data).toContain("Auto-Submitted: auto-generated\r\n");
  });
});

describe("encodeSubject", () => {
  it("ASCII だけなら包まない", () => {
    expect(encodeSubject("Invoice INV-2026-0042")).toBe("Invoice INV-2026-0042");
  });

  it("日本語は RFC 2047 で包む", () => {
    const encoded = encodeSubject("請求書");
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    expect(encoded.endsWith("?=")).toBe(true);
    expect(decodeBase64Utf8(encoded.slice(10, -2))).toContain("請求書");
  });
});

describe("extractAddress", () => {
  it("表示名つきからアドレスだけを取り出す", () => {
    expect(extractAddress("ProofKeeping <noreply@stek.ai>")).toBe("noreply@stek.ai");
  });

  it("`<>` が無ければそのまま", () => {
    expect(extractAddress("noreply@stek.ai")).toBe("noreply@stek.ai");
  });
});

describe("formatRfc5322Date", () => {
  it("日本時間で `+0900` を出す", () => {
    expect(formatRfc5322Date(NOW)).toBe("Fri, 21 Aug 2026 12:00:00 +0900");
  });

  it("`GMT` を出さない（RFC 5322 の形）", () => {
    expect(formatRfc5322Date(NOW)).not.toContain("GMT");
  });
});
