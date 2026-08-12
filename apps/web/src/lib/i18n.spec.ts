/**
 * `t()` と言語解決の検査。
 *
 * task: docs/tasks/P0-15.md
 */

import { describe, expect, it } from "vitest";

import { createTranslator, isLocale, resolveLocale, t } from "./i18n.js";

describe("t", () => {
  it("既定言語の文言を返す", () => {
    expect(t("app.brand")).toBe("ProofKeeping");
    expect(t("login.submit")).toBe("ログイン");
  });
});

describe("createTranslator", () => {
  it("その言語の訳を返す", () => {
    expect(createTranslator("en")("login.submit")).toBe("Sign in");
  });

  it("訳が無いキーは ja へ落ちる。キー名を返さない", () => {
    // 管理画面専用のキーは en に無い（ui-writing.md §1: 管理画面は日本語のみ）。
    const translate = createTranslator("en");
    expect(translate("nav.dashboard")).toBe("ダッシュボード");
  });

  it("ja は ja のまま", () => {
    expect(createTranslator("ja")("login.submit")).toBe("ログイン");
  });
});

describe("resolveLocale", () => {
  it("前の候補が優先される", () => {
    expect(resolveLocale("en", "ja")).toBe("en");
  });

  it("未対応・空の候補は飛ばす", () => {
    // DB に 7 言語のうち未実装のものが入っていても画面は空にならない。
    expect(resolveLocale("zh-CN", "en")).toBe("en");
    expect(resolveLocale(null, undefined, "en")).toBe("en");
  });

  it("候補がすべて外れたら ja", () => {
    expect(resolveLocale(null, undefined)).toBe("ja");
    expect(resolveLocale("vi")).toBe("ja");
  });

  it("候補が無ければ ja", () => {
    expect(resolveLocale()).toBe("ja");
  });
});

describe("isLocale", () => {
  it("対応言語だけを通す", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("zh-CN")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
});
