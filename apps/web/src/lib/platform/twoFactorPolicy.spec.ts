/**
 * 第 2 要素を要求するかの判定（PF-19 / DECISIONS #250）。
 *
 * **読めない設定を「無効化」と解さない**ことと、**production では
 * 値を読まない**ことを固定する。
 */

import { describe, expect, it } from "vitest";

import { isPlatformTwoFactorRequired, type TwoFactorPolicyEnv } from "./twoFactorPolicy.js";

function envWith(overrides: Partial<TwoFactorPolicyEnv>): TwoFactorPolicyEnv {
  return { ENVIRONMENT: "staging", PLATFORM_2FA_REQUIRED: "true", ...overrides };
}

describe("isPlatformTwoFactorRequired", () => {
  it("既定は要求する", () => {
    expect(isPlatformTwoFactorRequired(envWith({}))).toBe(true);
  });

  it("staging で `false` のときだけ要求しない", () => {
    expect(isPlatformTwoFactorRequired(envWith({ PLATFORM_2FA_REQUIRED: "false" }))).toBe(false);
  });

  it("**production では値を読まない**（`false` でも要求する）", () => {
    expect(
      isPlatformTwoFactorRequired(
        envWith({ ENVIRONMENT: "production", PLATFORM_2FA_REQUIRED: "false" }),
      ),
    ).toBe(true);
  });

  it("**読めない値は要求する側へ倒れる**（空・未設定・綴り違い・大文字）", () => {
    const values: string[] = ["", "  ", "0", "no", "FALSE", "False", "off", "disabled"];
    for (const value of values) {
      expect(isPlatformTwoFactorRequired(envWith({ PLATFORM_2FA_REQUIRED: value })), value).toBe(
        true,
      );
    }
    // **未設定**（vars を書き忘れた環境）も要求する側へ倒れる。
    const missing = { ENVIRONMENT: "staging" } as unknown as TwoFactorPolicyEnv;
    expect(isPlatformTwoFactorRequired(missing)).toBe(true);
  });

  it("local / preview でも `false` にできる（本番だけが特別）", () => {
    for (const environment of ["local", "preview", "staging"] as const) {
      expect(
        isPlatformTwoFactorRequired(
          envWith({ ENVIRONMENT: environment, PLATFORM_2FA_REQUIRED: "false" }),
        ),
        environment,
      ).toBe(false);
    }
  });
});
