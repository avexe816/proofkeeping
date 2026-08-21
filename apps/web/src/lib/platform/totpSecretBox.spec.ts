/**
 * TOTP secret の暗号化保管（PF-17 / DECISIONS #244）。
 *
 * 鍵はどちらも既知のテスト用の代役（credentials.spec.ts と同じ値）。
 * base64url を戻すと `0123456789abcdef0123456789abcdef` /
 * `fedcba9876543210fedcba9876543210` — 32 バイトであることだけが要件。
 */

import { describe, expect, it } from "vitest";

import { openTotpSecret, sealTotpSecret } from "./totpSecretBox.js";

type Env = import("@pk/db").Env;

const KEY_A = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const KEY_B = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA";

/** RFC 6238 Appendix B の公開テストベクタ（本物の秘密ではない）。 */
const PLAIN = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const OPERATOR_ID = "plat_op_01JBXQ3ZK8N4P2VYR60000";

function envWith(key: string | undefined): Env {
  return { TWO_FACTOR_ENCRYPTION_KEY: key } as unknown as Env;
}

describe("封と開封", () => {
  it("封をして開けると元に戻る", async () => {
    const env = envWith(KEY_A);
    const envelope = await sealTotpSecret(env, OPERATOR_ID, PLAIN);
    expect(await openTotpSecret(env, OPERATOR_ID, envelope)).toBe(PLAIN);
  });

  it("封筒は自己記述形式（pk2fa$v1$…）で、**平文を含まない**", async () => {
    const envelope = await sealTotpSecret(envWith(KEY_A), OPERATOR_ID, PLAIN);
    expect(envelope).toMatch(/^pk2fa\$v1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain(PLAIN);
  });

  it("IV は毎回変わる（同じ平文でも封筒が一致しない）", async () => {
    const env = envWith(KEY_A);
    const first = await sealTotpSecret(env, OPERATOR_ID, PLAIN);
    const second = await sealTotpSecret(env, OPERATOR_ID, PLAIN);
    expect(first).not.toBe(second);
  });
});

describe("開封できない条件（すべて null / 区別しない）", () => {
  it("別の鍵では開かない", async () => {
    const envelope = await sealTotpSecret(envWith(KEY_A), OPERATOR_ID, PLAIN);
    expect(await openTotpSecret(envWith(KEY_B), OPERATOR_ID, envelope)).toBeNull();
  });

  it("**別の担当者の封筒は開かない**（AAD の束縛 / 暗号文の載せ替え対策）", async () => {
    const env = envWith(KEY_A);
    const envelope = await sealTotpSecret(env, OPERATOR_ID, PLAIN);
    expect(await openTotpSecret(env, "plat_op_01JBXQ3ZK8N4P2VYR69999", envelope)).toBeNull();
  });

  it("改竄した暗号文は開かない（GCM の認証）", async () => {
    const env = envWith(KEY_A);
    const envelope = await sealTotpSecret(env, OPERATOR_ID, PLAIN);
    const tampered = envelope.slice(0, -2) + (envelope.endsWith("AA") ? "BB" : "AA");
    expect(await openTotpSecret(env, OPERATOR_ID, tampered)).toBeNull();
  });

  it("形式ちがい・接頭辞ちがいは開かない", async () => {
    const env = envWith(KEY_A);
    expect(await openTotpSecret(env, OPERATOR_ID, "not-an-envelope")).toBeNull();
    expect(await openTotpSecret(env, OPERATOR_ID, "pk2fa$v1$only-one-part")).toBeNull();
    expect(await openTotpSecret(env, OPERATOR_ID, "pk2fa$v1$a$b$c")).toBeNull();
    // 平文の base32 がそのまま入っていた場合も「読めない」= null。
    expect(await openTotpSecret(env, OPERATOR_ID, PLAIN)).toBeNull();
  });

  it("鍵が未設定なら開封は null（**投げない** — 応答から状態を読ませない）", async () => {
    const envelope = await sealTotpSecret(envWith(KEY_A), OPERATOR_ID, PLAIN);
    expect(await openTotpSecret(envWith(undefined), OPERATOR_ID, envelope)).toBeNull();
    expect(await openTotpSecret(envWith(""), OPERATOR_ID, envelope)).toBeNull();
  });
});

describe("封の失敗（設定漏れを黙って通さない）", () => {
  it("鍵が未設定なら封は**投げる**（名前だけ。値は含まない）", async () => {
    await expect(sealTotpSecret(envWith(undefined), OPERATOR_ID, PLAIN)).rejects.toThrow(
      "TWO_FACTOR_ENCRYPTION_KEY_MISSING",
    );
  });

  it("32 バイトでない鍵は拒む", async () => {
    await expect(sealTotpSecret(envWith("c2hvcnQ"), OPERATOR_ID, PLAIN)).rejects.toThrow(
      "TWO_FACTOR_ENCRYPTION_KEY_INVALID",
    );
  });

  it("例外メッセージに鍵や平文が入らない", async () => {
    const thrown = await sealTotpSecret(envWith("c2hvcnQ"), OPERATOR_ID, PLAIN).catch(
      (error: unknown) => error,
    );
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(PLAIN);
    expect(message).not.toContain("c2hvcnQ");
  });
});
