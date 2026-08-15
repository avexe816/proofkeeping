/**
 * 監査ログのマスク（P0-11）。
 *
 * ルール: .claude/rules/security.md §6
 *
 * ここが緩むと、**削除できない表**（INV-30 / 保存 5 年）へ
 * パスワードハッシュが入る。取り返しがつかないので正例・負例の両方を置く。
 */

import { describe, expect, it } from "vitest";

import { MASKED, maskSensitive, serializeAuditPayload } from "./mask.js";

/** 実在の認証情報から作った値ではない。形だけを再現している。 */
const HASH = "pbkdf2$sha256$5000$c2FsdA$aGFzaA";

describe("maskSensitive", () => {
  it.each([
    ["passwordHash", { passwordHash: HASH }],
    ["password_hash", { password_hash: HASH }],
    ["pinHash", { pinHash: HASH }],
    ["pin_hash", { pin_hash: HASH }],
    ["password", { password: "correct horse battery staple" }],
    ["pin", { pin: "1234" }],
    ["apiKey", { apiKey: "pk_live_xxx" }],
    ["credentialRef", { credentialRef: "kv:integration:1" }],
  ])("%s はマスクされる", (key, input) => {
    expect(maskSensitive(input)).toEqual({ [key]: MASKED });
  });

  it.each([
    ["staffNumber", { staffNumber: "S-0001" }],
    ["displayName", { displayName: "山田" }],
    ["role", { role: "CLEANER" }],
    ["isActive", { isActive: false }],
    ["failedLoginCount", { failedLoginCount: 5 }],
  ])("%s はそのまま残る", (_key, input) => {
    expect(maskSensitive(input)).toEqual(input);
  });

  it("鍵の名前が無害でも pbkdf2 形式の値はマスクされる", () => {
    // 鍵名の判定を補う二段目。`{ value: <hash> }` のような一般名で
    // 運ばれても形から落とす。
    expect(maskSensitive({ value: HASH })).toEqual({ value: MASKED });
  });

  it("入れ子のオブジェクトも辿る", () => {
    expect(maskSensitive({ before: { user: { staffNumber: "S-1", pinHash: HASH } } })).toEqual({
      before: { user: { staffNumber: "S-1", pinHash: MASKED } },
    });
  });

  it("配列の要素も辿る", () => {
    expect(maskSensitive([{ passwordHash: HASH }, { staffNumber: "S-2" }])).toEqual([
      { passwordHash: MASKED },
      { staffNumber: "S-2" },
    ]);
  });

  it("深すぎる入れ子は丸ごとマスクする", () => {
    // 循環参照で無限に潜らないための保険を兼ねる（MAX_DEPTH = 6）。
    let deep: unknown = { staffNumber: "S-3" };
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    expect(JSON.stringify(deep).includes("S-3")).toBe(true);
    expect(JSON.stringify(maskSensitive(deep)).includes("S-3")).toBe(false);
  });

  it("Date は ISO 文字列になる", () => {
    expect(maskSensitive({ at: new Date("2026-08-12T00:00:00.000Z") })).toEqual({
      at: "2026-08-12T00:00:00.000Z",
    });
  });

  it("null をオブジェクトとして辿らない", () => {
    expect(maskSensitive({ lockedUntil: null })).toEqual({ lockedUntil: null });
  });
});

describe("serializeAuditPayload", () => {
  it("undefined は null（記録しない）", () => {
    expect(serializeAuditPayload(undefined)).toBeNull();
  });

  it("マスクしてから JSON 文字列にする", () => {
    const json = serializeAuditPayload({ staffNumber: "S-0001", passwordHash: HASH });
    expect(json).toBe(`{"staffNumber":"S-0001","passwordHash":"${MASKED}"}`);
  });

  it("循環参照でも例外にならない（深さの上限で断ち切られる）", () => {
    // 監査ログの書き込みで落ちると本体の操作まで巻き添えになる。
    // `maskSensitive()` の MAX_DEPTH が先に効くため JSON 化に到達する。
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic["self"] = cyclic;
    const json = serializeAuditPayload(cyclic);
    expect(json).toContain(MASKED);
    expect(json?.length).toBeLessThan(500);
  });

  it("JSON 化できない値（BigInt）も null にする", () => {
    expect(serializeAuditPayload({ amount: 1n })).toBeNull();
  });
});
