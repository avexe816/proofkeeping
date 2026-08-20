/**
 * ダークモードのトークン（プロトタイプの `.dark`）。
 *
 * ── なぜ CSS を検査するのか ─────────────────────────────
 * ダークモードは**トークンの差し替え 1 か所**でできている。部品側は
 * `var(--surf)` などを読むだけなので、壊れるとすれば
 * 「`@media (prefers-color-scheme: dark)` を消した」
 * 「面か文字のどちらかだけ上書きした（白地に白文字になる）」
 * 「値をベタ書きしてトークンを迂回した」のいずれか。
 * **そのどれもがここで落ちる。**
 *
 * ── ブランド色は上書きしない ────────────────────────────
 * プロトタイプの `.dark` も `--brand` / `--accent` を触っていない。
 * topbar とサイドバーは元から濃色で、暗くしても同じ見え方になる。
 * ここで上書きが増えていたら、プロトタイプから離れた合図。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "app.css"), "utf8");

/** `@media (prefers-color-scheme: dark) { … }` の中身だけを取り出す。 */
function darkBlock(): string {
  const start = CSS.indexOf("@media (prefers-color-scheme: dark)");
  expect(start, "@media (prefers-color-scheme: dark) が無い").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error("dark のブロックが閉じていない");
}

/** 面と文字は**必ず対で**上書きする。片方だけだと読めなくなる。 */
const PAIRED_TOKENS = [
  ["--bg", "--ink"],
  ["--surf", "--ink2"],
] as const;

/** 状態色は色と背景が対。`--ok` だけ暗くすると淡い地に淡い字が乗る。 */
const STATE_TOKENS = [
  ["--ok", "--okbg"],
  ["--warn", "--warnbg"],
  ["--info", "--infobg"],
  ["--danger", "--dangerbg"],
  ["--dirty", "--dirtybg"],
] as const;

describe("ダークモード", () => {
  const block = darkBlock();

  it("`:root` を上書きする（body や個別のクラスに書かない）", () => {
    expect(block).toContain(":root");
  });

  it("`color-scheme: dark` を宣言する（フォーム部品を明るいまま残さない）", () => {
    expect(block).toContain("color-scheme: dark");
  });

  it.each([...PAIRED_TOKENS, ...STATE_TOKENS])("%s と %s を対で上書きする", (a, b) => {
    expect(block, `${a} が無い`).toContain(`${a}:`);
    expect(block, `${b} が無い`).toContain(`${b}:`);
  });

  it("ブランド色を上書きしない（プロトタイプの `.dark` と同じ）", () => {
    for (const token of ["--brand:", "--brand2:", "--brandTop:", "--accent:", "--accent2:"]) {
      expect(block, `${token} を上書きしている`).not.toContain(token);
    }
  });

  it("寸法のトークンを上書きしない（明るさの話に寸法を混ぜない）", () => {
    for (const token of ["--topbarHeight", "--sidebarWidth", "--brandWidth"]) {
      expect(block, `${token} を上書きしている`).not.toContain(token);
    }
  });

  /**
   * ── トークンを迂回した面が 1 つでもあると破れる ──────────
   * ダークモードはトークンの差し替えだけで効く。地の色をベタ書きした
   * 要素は**そこだけ明るいまま残り**、その上に `--ink`（明色）が乗って
   * 読めなくなる。文字色（`color: #fff` など）は濃色の地に乗るぶんには
   * 問題にならないので、ここが見るのは**地の色だけ。**
   *
   * `#fff` は例外として通す。案内カード（印刷前提・`color: #000` を
   * 併記）、QR のクワイエットゾーン（白でないと読み取り率が落ちる）、
   * 角印の台紙（透過 PNG の下敷き）の 3 つで、**いずれも文字を載せない。**
   */
  it("地の色をトークンの外でベタ書きしない（白の台紙を除く）", () => {
    const literals = [...CSS.matchAll(/background(?:-color)?:\s*(#[0-9a-f]{3,8}|\b(?!none\b)[a-z]+)\s*;/gi)]
      .map((match) => match[1]?.toLowerCase() ?? "")
      .filter((value) => value !== "#fff" && value !== "transparent" && value !== "none");

    expect(literals, "トークン化されていない地の色").toEqual([]);
  });
});
