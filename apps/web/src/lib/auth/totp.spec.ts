/**
 * TOTP（PF-17）。
 *
 * ── RFC 6238 Appendix B のベクタで固定する ──────────────
 * 付録のベクタは 8 桁なので、**下 6 桁**が本実装（6 桁）の期待値になる
 * （動的切り出しの値は同じで、桁数は最後の剰余だけが違う）。
 * 秘密は ASCII "12345678901234567890" の base32。
 */

import { describe, expect, it } from "vitest";

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  computeTotpCode,
  generateTotpSecret,
  totpStep,
  verifyTotpCode,
  TOTP_PARAMS,
} from "./totp.js";

/** RFC 6238 のテスト秘密（ASCII "12345678901234567890"）。 */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32", () => {
  it("エンコードとデコードが往復する", () => {
    const bytes = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30]);
    const encoded = base32Encode(bytes);
    expect(base32Decode(encoded)).toEqual(bytes);
  });

  it("RFC の秘密を正しく読む", () => {
    const decoded = base32Decode(RFC_SECRET);
    expect(decoded).not.toBeNull();
    expect(new TextDecoder().decode(decoded ?? new Uint8Array())).toBe("12345678901234567890");
  });

  it("小文字も読む（手入力の揺れ）", () => {
    expect(base32Decode(RFC_SECRET.toLowerCase())).toEqual(base32Decode(RFC_SECRET));
  });

  it("base32 でない文字は null（例外を投げない）", () => {
    expect(base32Decode("ABC1DEF")).toBeNull(); // 「1」はアルファベットに無い
    expect(base32Decode("")).toBeNull();
  });
});

describe("RFC 6238 Appendix B（SHA-1 / 下 6 桁）", () => {
  const VECTORS: readonly [number, string][] = [
    [59_000, "287082"],
    [1_111_111_109_000, "081804"],
    [1_111_111_111_000, "050471"],
    [1_234_567_890_000, "005924"],
    [2_000_000_000_000, "279037"],
    [20_000_000_000_000, "353130"],
  ];

  it.each(VECTORS)("t=%d ms → %s", async (nowMs, expected) => {
    expect(await computeTotpCode(RFC_SECRET, totpStep(nowMs))).toBe(expected);
  });

  it.each(VECTORS)("t=%d ms のコードが検証に通る", async (nowMs, code) => {
    expect(await verifyTotpCode(RFC_SECRET, code, nowMs)).toBe(totpStep(nowMs));
  });
});

describe("検証の窓（±1 ステップ）", () => {
  const NOW = 1_111_111_109_000; // step 37037036

  it("1 つ前のステップのコードが通り、そのステップ番号が返る", async () => {
    const previous = await computeTotpCode(RFC_SECRET, totpStep(NOW) - 1);
    expect(await verifyTotpCode(RFC_SECRET, previous ?? "", NOW)).toBe(totpStep(NOW) - 1);
  });

  it("1 つ先のステップのコードも通る（クロックずれ）", async () => {
    const next = await computeTotpCode(RFC_SECRET, totpStep(NOW) + 1);
    expect(await verifyTotpCode(RFC_SECRET, next ?? "", NOW)).toBe(totpStep(NOW) + 1);
  });

  it("2 つ離れたステップのコードは通らない", async () => {
    const far = await computeTotpCode(RFC_SECRET, totpStep(NOW) + 2);
    expect(await verifyTotpCode(RFC_SECRET, far ?? "", NOW)).toBeNull();
  });

  it("6 桁でない入力・数字でない入力は即 null", async () => {
    expect(await verifyTotpCode(RFC_SECRET, "12345", NOW)).toBeNull();
    expect(await verifyTotpCode(RFC_SECRET, "1234567", NOW)).toBeNull();
    expect(await verifyTotpCode(RFC_SECRET, "abcdef", NOW)).toBeNull();
  });

  it("壊れた秘密は null（例外を投げない）", async () => {
    expect(await verifyTotpCode("not-base32!", "123456", NOW)).toBeNull();
  });
});

describe("秘密の生成", () => {
  it("20 バイト → base32 32 文字", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)?.length).toBe(TOTP_PARAMS.secretBytes);
  });

  it("呼ぶたびに違う", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});

describe("otpauth URI", () => {
  it("発行者とアカウントをエンコードし、パラメータを固定で持つ", () => {
    const uri = buildOtpauthUri(RFC_SECRET, "ops@stek.ai", "ProofKeeping");
    expect(uri).toBe(
      `otpauth://totp/ProofKeeping:ops%40stek.ai?secret=${RFC_SECRET}&issuer=ProofKeeping&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
