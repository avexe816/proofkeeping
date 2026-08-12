/**
 * PIN のハッシュ化と検証（P0-09）。
 *
 * PBKDF2 は 1 回 10ms 前後掛かる。**ハッシュを作る回数を増やさないこと。**
 * 同じハッシュを使い回せるケースは `beforeAll` で 1 回だけ作る
 * （`password.spec.ts` と同じ方針）。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "./password.js";
import { PIN_PBKDF2_PARAMS, hashPin, pinNeedsRehash, verifyPin } from "./pin.js";

const PIN = "8261";
let stored = "";

beforeAll(async () => {
  stored = await hashPin(PIN);
});

describe("パラメータ", () => {
  it("反復回数は 50,000（DECISIONS #021）", () => {
    // 引き下げも引き上げも DECISIONS を書き直してから行うこと。
    // 引き上げる場合は pinLogin.ts の DUMMY_PIN_HASH も作り直す（timing を揃えるため）。
    expect(PIN_PBKDF2_PARAMS.iterations).toBe(50_000);
  });

  it("ソルトと導出値の長さはパスワードと同じ", () => {
    // 反復回数だけを下げる。ソルトを削ると 10,000 通りの総当たりが
    // 全ユーザーへ一度に波及する。
    expect(PIN_PBKDF2_PARAMS.saltBytes).toBe(16);
    expect(PIN_PBKDF2_PARAMS.keyBytes).toBe(32);
  });
});

describe("保存形式", () => {
  it("方式・反復回数・ソルト・導出値の 4 つを含む", () => {
    const [algorithm, hash, iterations, salt, key] = stored.split("$");
    expect(algorithm).toBe("pbkdf2");
    expect(hash).toBe("sha256");
    expect(iterations).toBe("50000");
    expect(salt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("同じ PIN でも毎回違う値になる（ソルトが乱数）", async () => {
    // 4 桁は候補が 10,000 通りしかない。ソルトが無ければ
    // 1 つの逆引き表で全員分が解ける。
    const again = await hashPin(PIN);
    expect(again).not.toBe(stored);
  });
});

describe("検証", () => {
  it("正しい PIN を通す", async () => {
    await expect(verifyPin(PIN, stored)).resolves.toBe(true);
  });

  it("1 桁違う PIN を落とす", async () => {
    await expect(verifyPin("8262", stored)).resolves.toBe(false);
  });

  it("桁の並びが違う PIN を落とす", async () => {
    await expect(verifyPin("8216", stored)).resolves.toBe(false);
  });

  it("空文字を落とす", async () => {
    await expect(verifyPin("", stored)).resolves.toBe(false);
  });

  it("前後に空白が付いた値を落とす", async () => {
    // 入力の trim は Zod 側の責務。ここは受け取った値をそのまま照合する。
    await expect(verifyPin(" 8261", stored)).resolves.toBe(false);
  });

  it.each([
    ["空文字", ""],
    ["区切りが足りない", "pbkdf2$sha256$50000$c2FsdA"],
    ["別方式（bcrypt の残骸）", "$2a$10$abcdefghijklmnopqrstuv"],
    ["別ハッシュ関数", "pbkdf2$sha512$50000$c2FsdA$aGFzaA"],
    ["反復回数が 0", "pbkdf2$sha256$0$c2FsdA$aGFzaA"],
    ["反復回数が数値でない", "pbkdf2$sha256$abc$c2FsdA$aGFzaA"],
    ["ソルトが空", "pbkdf2$sha256$50000$$aGFzaA"],
  ])("壊れた保存値（%s）は例外ではなく false", async (_label, broken) => {
    // 「解析できないから通す」を作らない。壊れた行はログインできないのが正しい。
    await expect(verifyPin(PIN, broken)).resolves.toBe(false);
  });

  it("反復回数の上限を超える値を受け付けない", async () => {
    // 細工された値で CPU を焼かせない。上限はパスワードと共通（840,000）。
    await expect(verifyPin(PIN, "pbkdf2$sha256$840001$c2FsdA$aGFzaA")).resolves.toBe(false);
  });

  it("パスワードの反復回数（210,000）で作られた値も検証できる", async () => {
    // 反復回数は保存値から読む。**現行パラメータと照合しない。**
    // ここが壊れると、反復回数を引き上げた瞬間に現場の全員が締め出される。
    const strong = await hashPassword(PIN);
    await expect(verifyPin(PIN, strong)).resolves.toBe(true);
  });
});

describe("pinNeedsRehash", () => {
  it("現行パラメータなら false", () => {
    expect(pinNeedsRehash(stored)).toBe(false);
  });

  it("反復回数が違えば true", () => {
    expect(pinNeedsRehash("pbkdf2$sha256$10000$c2FsdA$aGFzaA")).toBe(true);
  });

  it("解析できない値は true（作り直させる）", () => {
    expect(pinNeedsRehash("壊れた値")).toBe(true);
  });
});
