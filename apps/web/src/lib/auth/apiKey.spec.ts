/**
 * 公開 API のキー（P6-12 / PK-SPEC-P6 §6.1・§6.2）。
 *
 * ルール: .claude/rules/testing.md §3（正例・負例を最低 5 件ずつ）
 *
 * 完了条件（`docs/tasks/P6-12.md`）のうち、ここが押さえるもの:
 *   - **キーが作成時のみ全体表示される**（保存する値に平文が現れない）
 *   - 7 スコープが機能する
 */

import { API_SCOPE_CODES } from "@pk/contracts";
import { API_SCOPES } from "@pk/db";
import { describe, expect, it } from "vitest";

import {
  API_KEY_TOKEN_PREFIX,
  API_SCOPE_VALUES,
  allowedPropertyIdsOf,
  hasScope,
  hashApiKeyToken,
  isApiKeyUsable,
  issueApiKey,
  orgShortIdOfToken,
  readBearerToken,
} from "./apiKey.js";

const ORG_SHORT_ID = "a1b2c3";
const NOW = new Date("2026-09-10T05:00:00.000Z");

/** `Authorization` ヘッダだけを持つリクエスト。 */
function requestWith(header: string | null): Request {
  return new Request("https://pk.example/api/v1/public/tasks", {
    headers: header === null ? {} : { authorization: header },
  });
}

describe("issueApiKey — 発行", () => {
  it("`pk_live_{orgShortId}_` で始まる", async () => {
    const issued = await issueApiKey(ORG_SHORT_ID);
    expect(issued.token.startsWith(`${API_KEY_TOKEN_PREFIX}${ORG_SHORT_ID}_`)).toBe(true);
  });

  it("`keyPrefix` は `pk_live_{orgShortId}`（秘密を混ぜない）", async () => {
    const issued = await issueApiKey(ORG_SHORT_ID);
    expect(issued.keyPrefix).toBe(`${API_KEY_TOKEN_PREFIX}${ORG_SHORT_ID}`);
    // **表示用の値から秘密を復元できない。**
    expect(issued.token.startsWith(issued.keyPrefix)).toBe(true);
    expect(issued.token.length).toBeGreaterThan(issued.keyPrefix.length + 20);
  });

  it("`keyHash` はトークン全体の SHA-256（16 進 64 桁）", async () => {
    const issued = await issueApiKey(ORG_SHORT_ID);
    expect(issued.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.keyHash).toBe(await hashApiKeyToken(issued.token));
  });

  it("**保存する 2 つの値に平文が現れない**（§6.1 MUST）", async () => {
    const issued = await issueApiKey(ORG_SHORT_ID);
    expect(issued.keyHash).not.toContain(issued.token);
    expect(issued.keyPrefix).not.toBe(issued.token);
    // 秘密の部分がハッシュにも接頭辞にも入っていない。
    const secret = issued.token.split("_")[3] ?? "";
    expect(secret.length).toBeGreaterThan(20);
    expect(issued.keyHash).not.toContain(secret);
    expect(issued.keyPrefix).not.toContain(secret);
  });

  it("毎回違うトークンになる", async () => {
    const a = await issueApiKey(ORG_SHORT_ID);
    const b = await issueApiKey(ORG_SHORT_ID);
    expect(a.token).not.toBe(b.token);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it("字母に紛らわしい文字が無い（Crockford Base32）", async () => {
    const issued = await issueApiKey(ORG_SHORT_ID);
    const secret = issued.token.split("_")[3] ?? "";
    expect(secret).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
    expect(secret).not.toMatch(/[ILOU]/);
  });
});

describe("orgShortIdOfToken — 正例", () => {
  it("発行したトークンから組織短縮 ID を取れる", async () => {
    const issued = await issueApiKey(ORG_SHORT_ID);
    expect(orgShortIdOfToken(issued.token)).toBe(ORG_SHORT_ID);
  });

  it("別の組織なら別の値", async () => {
    const other = await issueApiKey("z9y8x7");
    expect(orgShortIdOfToken(other.token)).toBe("z9y8x7");
  });
});

describe("orgShortIdOfToken — 負例（形が違う）", () => {
  it.each([
    "",
    "pk_live_",
    "pk_test_a1b2c3_ABCDEFGHJKMNPQRSTVWXYZ",
    "pk_live_A1B2C3_ABCDEFGHJKMNPQRSTVWXYZ", // 組織短縮 ID は小文字英数
    "pk_live_a1b2c3_short",
    "pk_live_a1b2c3_abcdefghjkmnpqrstvwxyz", // 秘密は大文字
    "Bearer pk_live_a1b2c3_ABCDEFGHJKMNPQRSTVWXYZ",
  ])("`%s` は読めない", (token) => {
    expect(orgShortIdOfToken(token)).toBeNull();
  });
});

describe("readBearerToken", () => {
  it("`Bearer ` の後ろを返す", () => {
    expect(readBearerToken(requestWith("Bearer pk_live_x"))).toBe("pk_live_x");
  });

  it("前後の空白を落とす", () => {
    expect(readBearerToken(requestWith("  Bearer pk_live_x  "))).toBe("pk_live_x");
  });

  it("ヘッダが無ければ `null`", () => {
    expect(readBearerToken(requestWith(null))).toBeNull();
  });

  it("**`Basic` を通さない**（キーが認証ダイアログに乗る経路を作らない）", () => {
    expect(readBearerToken(requestWith("Basic cGs6bGl2ZQ=="))).toBeNull();
  });

  it("方式が無ければ `null`", () => {
    expect(readBearerToken(requestWith("pk_live_a1b2c3_ABCDEFGHJKMNPQRSTVWXYZ"))).toBeNull();
  });
});

describe("hasScope — 7 スコープ（§6.2）", () => {
  it("§6.2 の 7 つがそのまま並んでいる", () => {
    expect(API_SCOPE_VALUES).toHaveLength(7);
    expect([...API_SCOPE_VALUES]).toEqual([...API_SCOPES]);
    expect([...API_SCOPE_VALUES]).toEqual([...API_SCOPE_CODES]);
  });

  it("持っているスコープは通る", () => {
    expect(hasScope(["tasks:read", "findings:read"], "tasks:read")).toBe(true);
  });

  it("持っていないスコープは通らない", () => {
    expect(hasScope(["tasks:read"], "invoices:read")).toBe(false);
  });

  it("空なら 1 つも通らない", () => {
    for (const scope of API_SCOPE_VALUES) {
      expect(hasScope([], scope), scope).toBe(false);
    }
  });

  it("**ワイルドカードを実装しない**（`occupancy:*` は何にも当たらない）", () => {
    expect(hasScope(["occupancy:*"], "occupancy:write")).toBe(false);
  });

  it("読みのスコープが書きを兼ねない", () => {
    expect(hasScope(["tasks:read"], "occupancy:write")).toBe(false);
  });
});

describe("isApiKeyUsable — 正例（使える）", () => {
  it("期限も失効も無ければ使える", () => {
    expect(isApiKeyUsable({ expiresAt: null, revokedAt: null }, NOW)).toBe(true);
  });

  it("期限が未来なら使える", () => {
    const future = new Date(NOW.getTime() + 1000);
    expect(isApiKeyUsable({ expiresAt: future, revokedAt: null }, NOW)).toBe(true);
  });
});

describe("isApiKeyUsable — 負例（使えない）", () => {
  it("失効していれば使えない", () => {
    expect(isApiKeyUsable({ expiresAt: null, revokedAt: NOW }, NOW)).toBe(false);
  });

  it("**失効が有効期限より先に効く**（期限が未来でも通さない）", () => {
    const future = new Date(NOW.getTime() + 86_400_000);
    expect(isApiKeyUsable({ expiresAt: future, revokedAt: NOW }, NOW)).toBe(false);
  });

  it("期限ちょうどは期限切れ（含まない）", () => {
    expect(isApiKeyUsable({ expiresAt: NOW, revokedAt: null }, NOW)).toBe(false);
  });

  it("期限が過去なら使えない", () => {
    const past = new Date(NOW.getTime() - 1000);
    expect(isApiKeyUsable({ expiresAt: past, revokedAt: null }, NOW)).toBe(false);
  });

  it("失効時刻が未来でも（時計のずれ）使えない扱い", () => {
    const future = new Date(NOW.getTime() + 1000);
    expect(isApiKeyUsable({ expiresAt: null, revokedAt: future }, NOW)).toBe(false);
  });
});

describe("allowedPropertyIdsOf — `null` と `[]` を区別する", () => {
  it("`null`（組織全体）は空配列へ写す", () => {
    expect(allowedPropertyIdsOf(null)).toEqual([]);
  });

  it("`[]`（1 件も見えない）も空配列", () => {
    // **`role` の側で区別する**（`middleware/apiKey.ts`）。
    // `null` は `ORG_ADMIN`、`[]` は `PROPERTY_MANAGER` ＋ 空。
    expect(allowedPropertyIdsOf([])).toEqual([]);
  });

  it("配列はそのまま写す", () => {
    expect(allowedPropertyIdsOf(["a", "b"])).toEqual(["a", "b"]);
  });

  it("元の配列を書き換えない", () => {
    const source = ["a"];
    const copied = allowedPropertyIdsOf(source);
    copied.push("b");
    expect(source).toEqual(["a"]);
  });
});
