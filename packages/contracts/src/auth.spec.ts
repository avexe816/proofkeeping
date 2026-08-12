/**
 * 認証スキーマ（P0-08 パスワード / P0-09 PIN）。
 *
 * ここで確かめるのは**入口で何を落とすか**だけ。認証の判定は
 * `apps/web/src/lib/auth/*.spec.ts` が見る。
 */

import { describe, expect, it } from "vitest";

import {
  PIN_POLICY,
  loginRequestSchema,
  pinLoginRequestSchema,
  pinSchema,
} from "./auth.js";

describe("pinSchema（登録時）", () => {
  it("PIN は 4 桁", () => {
    expect(PIN_POLICY.length).toBe(4);
  });

  it.each(["8261", "0492", "7013", "2580", "9074"])("通常の PIN（%s）を通す", (pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(true);
  });

  it.each(["0000", "1111", "5555", "8888", "9999"])("ゾロ目（%s）を拒否する", (pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(false);
  });

  it.each(["0123", "1234", "3456", "6789", "2345"])("昇順の連番（%s）を拒否する", (pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(false);
  });

  it.each(["4321", "9876", "3210", "5432", "7654"])("降順の連番（%s）を拒否する", (pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(false);
  });

  it.each([
    ["3 桁", "123"],
    ["5 桁", "12345"],
    ["空文字", ""],
    ["英字を含む", "12a4"],
    ["記号を含む", "12-4"],
    ["全角数字", "８２６１"],
    ["前後に空白", " 8261 "],
  ])("形が違う値（%s）を拒否する", (_label, pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(false);
  });

  it("巡回（0 を跨ぐ並び）は連番として扱わない", () => {
    // 拒否の理由を現場に説明できる範囲に留める。ここを広げると
    // 「なぜこの PIN が登録できないのか」が伝わらなくなる。
    expect(pinSchema.safeParse("9012").success).toBe(true);
    expect(pinSchema.safeParse("1098").success).toBe(true);
  });
});

describe("pinLoginRequestSchema（ログイン時）", () => {
  function credentials(pin: string) {
    return { orgShortId: "a1b2c3", staffNumber: "S-0001", pin };
  }

  it.each(["1111", "1234", "4321", "0000", "9876"])(
    "ポリシー違反の PIN（%s）でもログイン入力としては通す",
    (pin) => {
      // ポリシーを掛けると (1) 追加前に登録された PIN で入れなくなり、
      // (2) 400 と 401 の差からその PIN の形が読める。
      expect(pinLoginRequestSchema.safeParse(credentials(pin)).success).toBe(true);
    },
  );

  it.each([
    ["3 桁", "123"],
    ["5 桁", "12345"],
    ["空文字", ""],
    ["英字を含む", "abcd"],
    ["全角数字", "８２６１"],
  ])("4 桁の数字でない値（%s）は落とす", (_label, pin) => {
    expect(pinLoginRequestSchema.safeParse(credentials(pin)).success).toBe(false);
  });

  it("orgShortId を小文字へ寄せる（口頭・印刷物からの転記）", () => {
    const parsed = pinLoginRequestSchema.safeParse({
      orgShortId: "A1B2C3",
      staffNumber: "S-0001",
      pin: "8261",
    });
    expect(parsed.success && parsed.data.orgShortId).toBe("a1b2c3");
  });

  it("スタッフ番号の大文字小文字は変換しない（DB の UNIQUE が case-sensitive）", () => {
    const parsed = pinLoginRequestSchema.safeParse(credentials("8261"));
    expect(parsed.success && parsed.data.staffNumber).toBe("S-0001");
  });

  it("password を渡しても PIN の入力にはならない", () => {
    const parsed = pinLoginRequestSchema.safeParse({
      orgShortId: "a1b2c3",
      staffNumber: "S-0001",
      password: "Correct1Horse",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("loginRequestSchema（P0-08 の回帰）", () => {
  it("ログイン時にパスワードポリシーを掛けない", () => {
    // ポリシー変更前に作られたパスワードで締め出さないため。
    const parsed = loginRequestSchema.safeParse({
      orgShortId: "a1b2c3",
      staffNumber: "S-0001",
      password: "short",
    });
    expect(parsed.success).toBe(true);
  });
});
