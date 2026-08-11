/**
 * パスワードの設定（P0-08）。ポリシーと直近 3 世代の再利用禁止。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listRecentPasswordHashes = vi.fn();
const setPasswordHash = vi.fn();

vi.mock("@pk/db", () => ({
  listRecentPasswordHashes: (...args: unknown[]) => listRecentPasswordHashes(...args) as unknown,
  setPasswordHash: (...args: unknown[]) => setPasswordHash(...args) as unknown,
}));

const { hashPassword, verifyPassword } = await import("./password.js");
const { setUserPassword } = await import("./setPassword.js");

type Env = import("@pk/db").Env;
type TenantContext = import("@pk/db").TenantContext;

const ENV = {} as unknown as Env;
const CTX = {
  organizationId: "org_test_alpha",
  orgShortId: "a1b2c3",
  role: "ORG_ADMIN",
  allowedPropertyIds: [],
  now: new Date("2026-08-11T09:00:00.000Z"),
} as unknown as TenantContext;
const USER_ID = "a1b2c3__usr_01JBXQ3ZK8N4P2VYR60000";

beforeEach(() => {
  vi.clearAllMocks();
  listRecentPasswordHashes.mockResolvedValue([]);
  setPasswordHash.mockResolvedValue(undefined);
});

describe("ポリシー（security.md §2）", () => {
  it.each([
    ["10 文字ちょうど・英大小数字", "Abcdefgh12"],
    ["記号を含む", "Abcdefgh12!#$"],
    ["日本語を含む", "Abcdefgh12あいう"],
  ])("通る: %s", async (_label, password) => {
    const result = await setUserPassword(ENV, CTX, { userId: USER_ID, newPassword: password });
    expect(result).toEqual({ ok: true });
  });

  it.each([
    ["9 文字", "Abcdefg12"],
    ["大文字が無い", "abcdefgh12"],
    ["小文字が無い", "ABCDEFGH12"],
    ["数字が無い", "Abcdefghij"],
    ["空文字", ""],
    ["257 文字", `A1${"a".repeat(255)}`],
  ])("落ちる: %s", async (_label, password) => {
    const result = await setUserPassword(ENV, CTX, { userId: USER_ID, newPassword: password });
    expect(result).toEqual({ ok: false, reason: "POLICY_VIOLATION" });
    // 落ちたら書かない。
    expect(setPasswordHash).not.toHaveBeenCalled();
  });
});

describe("直近 3 世代の再利用禁止", () => {
  it("履歴と同じ平文なら REUSED（ソルトが違っても検出する）", async () => {
    const password = "Abcdefgh12";
    listRecentPasswordHashes.mockResolvedValue([await hashPassword(password)]);
    const result = await setUserPassword(ENV, CTX, { userId: USER_ID, newPassword: password });
    expect(result).toEqual({ ok: false, reason: "REUSED" });
    expect(setPasswordHash).not.toHaveBeenCalled();
  });

  it("3 世代のうち最も古いものと同じでも REUSED", async () => {
    const password = "Abcdefgh12";
    listRecentPasswordHashes.mockResolvedValue([
      await hashPassword("Zyxwvuts98"),
      await hashPassword("Qwertyui34"),
      await hashPassword(password),
    ]);
    const result = await setUserPassword(ENV, CTX, { userId: USER_ID, newPassword: password });
    expect(result).toEqual({ ok: false, reason: "REUSED" });
  });

  it("どの世代とも違えば設定できる", async () => {
    listRecentPasswordHashes.mockResolvedValue([await hashPassword("Zyxwvuts98")]);
    const result = await setUserPassword(ENV, CTX, {
      userId: USER_ID,
      newPassword: "Abcdefgh12",
    });
    expect(result).toEqual({ ok: true });
  });

  it("ポリシー違反は履歴を引く前に落とす（無駄な PBKDF2 を回さない）", async () => {
    await setUserPassword(ENV, CTX, { userId: USER_ID, newPassword: "short" });
    expect(listRecentPasswordHashes).not.toHaveBeenCalled();
  });
});

describe("保存", () => {
  it("平文ではなくハッシュを渡す", async () => {
    const password = "Abcdefgh12";
    await setUserPassword(ENV, CTX, { userId: USER_ID, newPassword: password });

    expect(setPasswordHash).toHaveBeenCalledTimes(1);
    const [, , input] = setPasswordHash.mock.calls[0] as [unknown, unknown, { passwordHash: string }];
    expect(input.passwordHash).not.toContain(password);
    expect(input.passwordHash.startsWith("pbkdf2$sha256$")).toBe(true);
    await expect(verifyPassword(password, input.passwordHash)).resolves.toBe(true);
  });
});
