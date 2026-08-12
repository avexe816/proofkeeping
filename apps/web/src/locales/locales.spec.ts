/**
 * 文言カタログの検査。
 *
 * task: docs/tasks/P0-15.md
 *
 * ── ESLint が .json を見ない ────────────────────────────
 * `pk/no-forbidden-words` の `files` は locales 配下の .ts / .tsx / .json を
 * 含むが、**ESLint は既定で .json を解析しない。** P0-14 の `ja.ts` を
 * JSON へ移した時点で、文言が lint の外へ出る。ここで同じ語彙表
 * （ルール本体の `FORBIDDEN`）を使って検査し直す。
 */

import { describe, expect, it } from "vitest";

// ルールの実体は .js（型情報なしで検査される設定ファイル群の一部）。
// **語彙表をここへ写経しないこと。** 写すと片方だけ更新される。
import { FORBIDDEN } from "../../../../packages/config/eslint/rules/forbidden-words-list.js";

import { CATALOGS, LOCALES, en, ja } from "./index.js";

describe("locales", () => {
  it("ja がすべてのキーを持つ", () => {
    // `MessageKey` は ja から導いているので、型では自明に真になる。
    // ここで見るのは「空文字のキーを置いていないか」。
    for (const [key, value] of Object.entries(ja)) {
      expect(value, key).not.toBe("");
    }
  });

  it("ja 以外のカタログに ja へ無いキーが無い", () => {
    const known = new Set(Object.keys(ja));
    for (const locale of LOCALES) {
      for (const key of Object.keys(CATALOGS[locale])) {
        expect(known.has(key), `${locale}: ${key}`).toBe(true);
      }
    }
  });

  it("en は部分集合でよい（欠けたキーは ja へ落ちる）", () => {
    expect(Object.keys(en).length).toBeGreaterThan(0);
    expect(Object.keys(en).length).toBeLessThan(Object.keys(ja).length);
  });

  it("禁止語を含まない", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(CATALOGS[locale])) {
        for (const [word] of FORBIDDEN) {
          expect(value.includes(word), `${locale}: ${key} に「${word}」`).toBe(false);
        }
      }
    }
  });
});
