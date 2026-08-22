/**
 * `t()` と言語解決の検査。
 *
 * task: docs/tasks/P0-15.md
 */

import { STAFF_LOCALES } from "@pk/contracts";
import { describe, expect, it } from "vitest";

import { ja } from "../locales/index.js";

import { LOCALES, createTranslator, isLocale, resolveLocale, t, type MessageKey } from "./i18n.js";

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
    // DB に対応外の言語コードが入っていても画面は空にならない。
    // （zh-CN などの 5 言語は 2026-08-16 に対応済み。ここでは対応表に
    //   無いコードを使う）
    expect(resolveLocale("fr", "en")).toBe("en");
    expect(resolveLocale(null, undefined, "en")).toBe("en");
  });

  it("候補がすべて外れたら ja", () => {
    expect(resolveLocale(null, undefined)).toBe("ja");
    expect(resolveLocale("ko")).toBe("ja");
  });

  it("候補が無ければ ja", () => {
    expect(resolveLocale()).toBe("ja");
  });
});

describe("isLocale", () => {
  it("対応言語だけを通す", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("en")).toBe(true);
    // 契約 §7.1 の 7 言語（DECISIONS #198）。
    expect(isLocale("zh-CN")).toBe(true);
    expect(isLocale("vi")).toBe(true);
    expect(isLocale("id")).toBe(true);
    expect(isLocale("my")).toBe(true);
    expect(isLocale("ne")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
  });
});

/**
 * 現場の表示言語が 2 か所で食い違わないこと（DECISIONS #267）。
 *
 * 一覧は 2 か所にある。**片方だけ増える壊れ方をここで止める。**
 *
 *   `packages/contracts` の `STAFF_LOCALES`   登録・編集で受け付ける値
 *   `apps/web/src/locales` の `LOCALES`       翻訳が揃っている言語
 *
 * 受け付ける値のほうが多いと**翻訳の無い言語で登録できてしまい**、
 * 少ないと**訳してあるのに選べない**（実際そうなっていた — 以前の
 * `z.enum(["ja", "en"])`）。
 */
describe("現場の表示言語", () => {
  it("`STAFF_LOCALES` と `LOCALES` が同じ集合", () => {
    expect([...STAFF_LOCALES].sort()).toEqual([...LOCALES].sort());
  });

  it("並びも同じ（画面の選択肢の順序が契約 §7.1 のまま）", () => {
    expect([...STAFF_LOCALES]).toEqual([...LOCALES]);
  });

  it("7 言語ある（契約 §7.1）", () => {
    expect(STAFF_LOCALES).toHaveLength(7);
  });

  it("すべての言語に画面の表示名がある", () => {
    for (const locale of STAFF_LOCALES) {
      expect(ja[`staff.language.${locale}` as MessageKey], locale).toBeTruthy();
    }
  });
});
