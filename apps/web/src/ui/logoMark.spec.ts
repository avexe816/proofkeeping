/**
 * ブランドマークが 2 か所で食い違わないこと（DECISIONS #270）。
 *
 * ── なぜ検査するのか ────────────────────────────────────
 * HTML の中の図形はブラウザのタブのアイコンにできないので、
 * **同じ絵が 2 つのファイルにある**（`ui/Logo.tsx` と
 * `public/favicon.svg`）。片方だけ直すと、画面とタブで違う絵が出る。
 * 実際に**柄の向きを直したときに起こりかけた**（人間の指摘 2026-08-22）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const LOGO = readFileSync(join(import.meta.dirname, "Logo.tsx"), "utf8");
const FAVICON = readFileSync(
  join(import.meta.dirname, "..", "..", "public", "favicon.svg"),
  "utf8",
);

/** `d="..."` の中身を出てくる順に集める。 */
function paths(source: string): string[] {
  return [...source.matchAll(/d="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("ブランドマーク", () => {
  it("**画面とタブで同じ図形**（片方だけ直していない）", () => {
    const inScreen = paths(LOGO);
    const inTab = paths(FAVICON);
    expect(inScreen.length, "Logo.tsx の path が 3 本でない").toBe(3);
    expect(inTab).toEqual(inScreen);
  });

  it("色も同じ", () => {
    for (const color of ["#6e9c7e", "#c09b4f"]) {
      expect(LOGO, color).toContain(color);
      expect(FAVICON, color).toContain(color);
    }
  });

  it("**柄は左下へ伸びる**（元絵のとおり / 左右を取り違えない）", () => {
    // 葉は左右対称なので、向きを決めているのは柄だけ。
    // 終点の x が中心（16）より小さいこと＝左へ向いていること。
    const stem = paths(LOGO)[2] ?? "";
    const end = /,\s*([\d.]+)\s+[\d.]+$/.exec(stem.trim());
    expect(end, `柄の終点が読めない: ${stem}`).not.toBeNull();
    expect(Number(end?.[1])).toBeLessThan(16);
  });

  it("外の画像も CDN も読まない（CLAUDE.md §4 / 自前の図形だけ）", () => {
    // **`xmlns` は名前空間の宣言**で、通信ではない。落としてから見る。
    const withoutNamespace = (source: string): string =>
      source.replaceAll('xmlns="http://www.w3.org/2000/svg"', "");

    for (const forbidden of ["http://", "https://", "<image", "xlink:href", "url("]) {
      expect(withoutNamespace(LOGO), forbidden).not.toContain(forbidden);
      expect(withoutNamespace(FAVICON), forbidden).not.toContain(forbidden);
    }
  });
});
