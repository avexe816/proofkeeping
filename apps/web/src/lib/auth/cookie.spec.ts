/**
 * セッション Cookie の署名と組み立て（P0-08）。
 */

import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  buildExpiredSessionCookie,
  buildSessionCookie,
  readSessionCookie,
  signSessionId,
  verifySignedSessionId,
} from "./cookie.js";

const SECRET = "test-session-secret-not-used-anywhere-else";
const SESSION_ID = "Zm9vYmFyLXNlc3Npb24taWQtZm9yLXRlc3Q";

describe("署名", () => {
  it("署名した値から元の ID を取り出せる", async () => {
    const signed = await signSessionId(SESSION_ID, SECRET);
    await expect(verifySignedSessionId(signed, SECRET)).resolves.toBe(SESSION_ID);
  });

  it("同じ入力なら同じ署名（KV のキーが安定する）", async () => {
    const a = await signSessionId(SESSION_ID, SECRET);
    const b = await signSessionId(SESSION_ID, SECRET);
    expect(a).toBe(b);
  });

  it("鍵が違えば通らない", async () => {
    const signed = await signSessionId(SESSION_ID, SECRET);
    await expect(verifySignedSessionId(signed, "another-secret")).resolves.toBeNull();
  });

  it("ID を書き換えた値は通らない", async () => {
    const signed = await signSessionId(SESSION_ID, SECRET);
    const [, signature] = signed.split(".");
    await expect(
      verifySignedSessionId(`${SESSION_ID}x.${signature ?? ""}`, SECRET),
    ).resolves.toBeNull();
  });

  it("署名を書き換えた値は通らない", async () => {
    const signed = await signSessionId(SESSION_ID, SECRET);
    await expect(verifySignedSessionId(`${signed}x`, SECRET)).resolves.toBeNull();
  });

  it.each([
    ["署名が無い", SESSION_ID],
    ["区切りだけ", "."],
    ["ID が空", ".signature"],
    ["署名が空", `${SESSION_ID}.`],
    ["空文字", ""],
    ["ID に使えない文字", "not/base64url.signature"],
  ])("壊れた値（%s）は null", async (_label, value) => {
    await expect(verifySignedSessionId(value, SECRET)).resolves.toBeNull();
  });
});

describe("Set-Cookie", () => {
  it("security.md §2 の属性をすべて持つ", () => {
    const cookie = buildSessionCookie("value", 43_200);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=value`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=43200");
  });

  it("ログアウト用は Max-Age=0", () => {
    expect(buildExpiredSessionCookie()).toContain("Max-Age=0");
  });

  it("SameSite=None を出さない（CSRF の防御を外さない）", () => {
    expect(buildSessionCookie("value", 60)).not.toContain("SameSite=None");
  });
});

describe("Cookie ヘッダの解析", () => {
  it("単独で入っていれば読める", () => {
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=abc`)).toBe("abc");
  });

  it("他の Cookie と並んでいても読める", () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE_NAME}=abc; lang=ja`)).toBe("abc");
  });

  it("名前が前方一致する別の Cookie を拾わない", () => {
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}_old=abc`)).toBeNull();
  });

  it("値が空なら null", () => {
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });

  it("ヘッダが無ければ null", () => {
    expect(readSessionCookie(null)).toBeNull();
  });
});
