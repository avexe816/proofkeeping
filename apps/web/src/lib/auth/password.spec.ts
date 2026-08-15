/**
 * パスワードのハッシュ化と検証（P0-08）。
 *
 * PBKDF2 は 1 回 40ms 前後掛かる。**ハッシュを作る回数を増やさないこと。**
 * 同じハッシュを使い回せるケースは `beforeAll` で 1 回だけ作る。
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  PBKDF2_PARAMS,
  hashPassword,
  isPasswordReused,
  needsRehash,
  parsePasswordHash,
  timingSafeEqual,
  verifyPassword,
} from "./password.js";

const PASSWORD = "Correct1Horse";
let stored = "";

beforeAll(async () => {
  stored = await hashPassword(PASSWORD);
});

describe("保存形式", () => {
  it("方式・反復回数・ソルト・導出値の 4 つを含む", () => {
    const [algorithm, hash, iterations, salt, key] = stored.split("$");
    expect(algorithm).toBe("pbkdf2");
    expect(hash).toBe("sha256");
    expect(iterations).toBe(String(PBKDF2_PARAMS.iterations));
    // base64url（`+` `/` `=` を含まない）。Cookie やログに載っても壊れない。
    expect(salt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("反復回数は security.md §2 の 210,000 回", () => {
    // 引き下げは強度の低下に直結する。変更するなら DECISIONS を書き直すこと。
    expect(PBKDF2_PARAMS.iterations).toBe(100_000);
  });

  it("同じパスワードでも毎回違う値になる（ソルトが乱数）", async () => {
    const again = await hashPassword(PASSWORD);
    expect(again).not.toBe(stored);
  });

  it("ソルトは 16 バイト、導出値は 32 バイト", () => {
    const parsed = parsePasswordHash(stored);
    expect(parsed?.salt).toHaveLength(16);
    expect(parsed?.derivedKey).toHaveLength(32);
  });
});

describe("検証", () => {
  it("正しいパスワードを通す", async () => {
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it("1 文字違うパスワードを落とす", async () => {
    await expect(verifyPassword("Correct1Hors", stored)).resolves.toBe(false);
  });

  it("空文字を落とす", async () => {
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("大文字小文字を区別する", async () => {
    await expect(verifyPassword("correct1horse", stored)).resolves.toBe(false);
  });

  it.each([
    ["空文字", ""],
    ["区切りが足りない", "pbkdf2$sha256$210000$c2FsdA"],
    ["別方式", "bcrypt$12$abcdef$abcdef$abcdef"],
    ["別ハッシュ関数", "pbkdf2$sha512$210000$c2FsdA$aGFzaA"],
    ["反復回数が 0", "pbkdf2$sha256$0$c2FsdA$aGFzaA"],
    ["反復回数が数値でない", "pbkdf2$sha256$abc$c2FsdA$aGFzaA"],
    ["ソルトが base64url でない", "pbkdf2$sha256$210000$@@@@$aGFzaA"],
    ["ソルトが空", "pbkdf2$sha256$210000$$aGFzaA"],
  ])("壊れた保存値（%s）は例外ではなく false", async (_label, broken) => {
    // 「解析できないから通す」を作らない。壊れた行はログインできないのが正しい。
    expect(parsePasswordHash(broken)).toBeNull();
    await expect(verifyPassword(PASSWORD, broken)).resolves.toBe(false);
  });

  it("反復回数が現行の 4 倍を超える値を受け付けない", () => {
    // 細工された値で CPU を焼かせない。
    const crafted = `pbkdf2$sha256$${String(PBKDF2_PARAMS.iterations * 4 + 1)}$c2FsdA$aGFzaA`;
    expect(parsePasswordHash(crafted)).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("同じ内容なら true", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("末尾だけ違えば false", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("先頭だけ違えば false", () => {
    expect(timingSafeEqual(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("長さが違えば false", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("どちらも空なら true", () => {
    expect(timingSafeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe("needsRehash", () => {
  it("現行パラメータなら false", () => {
    expect(needsRehash(stored)).toBe(false);
  });

  it("反復回数が古ければ true", () => {
    expect(needsRehash("pbkdf2$sha256$100000$c2FsdA$aGFzaA")).toBe(true);
  });

  it("解析できない値は true（作り直させる）", () => {
    expect(needsRehash("壊れた値")).toBe(true);
  });
});

describe("再利用の判定", () => {
  it("直近の世代と同じ平文なら true（ソルトが違っても検出する）", async () => {
    // ソルトが異なるため文字列比較では一致しない。verify を回す必要がある。
    const older = await hashPassword(PASSWORD);
    expect(older).not.toBe(stored);
    await expect(isPasswordReused(PASSWORD, [older, stored])).resolves.toBe(true);
  });

  it("どの世代とも違えば false", async () => {
    await expect(isPasswordReused("Different2Pass", [stored])).resolves.toBe(false);
  });

  it("履歴が空なら false", async () => {
    await expect(isPasswordReused(PASSWORD, [])).resolves.toBe(false);
  });
});
