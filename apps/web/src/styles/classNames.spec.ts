/**
 * 画面が使うクラスが CSS に在ることを固定する。
 *
 * ── なぜ機械で見るのか ──────────────────────────────────
 * 未定義のクラスは**エラーにならず、素の要素として描かれる。**
 * typecheck も lint も通る種類の壊れ方なので、走査で押さえる。
 * 実際に 3 件見つかっている。
 *
 *   `pk-m-screen`      `report.tsx` だけが `head` と `body` を包んでいて、
 *                      `.pk-m`（flex の列）と `.pk-m-body { flex: 1 }` の
 *                      親子が切れ、本文が縦に伸びていなかった
 *   `pk-m-group__toggle` 施設帯の ▸ / ▾ が素の文字で出ていた
 *   `pk-row--inactive` 無効化した客室タイプの行がグレーにならなかった
 *                      （家の作法は `pk-row--muted`）
 *
 * ── 見るのは「在るか」だけ ──────────────────────────────
 * 描画も見た目も見ない（sidebarLayout.spec.ts と同じ流儀）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const STYLES = import.meta.dirname;
const SRC = join(STYLES, "..");
const MOBILE_ROUTES = join(SRC, "routes", "m");

const CSS = ["app.css", "mobile.css"]
  .map((file) => readFileSync(join(STYLES, file), "utf8"))
  .join("\n");

/**
 * CSS を持たなくてよいもの。**理由を書けるものだけを並べる。**
 * 増やすときは、なぜ規則が要らないのかをここに残すこと。
 */
const WITHOUT_RULE: Record<string, string> = {
  // クラスではなく `<datalist id>`。`list=` から参照される。
  "pk-property-options": "datalist の id",
  // 修飾子（`--over`）と子孫セレクタの足場。素の行に足す見た目は無い。
  "pk-assign__row": "修飾子の足場",
  // セクションの囲い。素の行に足す見た目は無い（`--closed` の方は
  // `.pk-sidebar__items` を 0fr へ畳む規則を持つので、ここには要らない）。
  "pk-sidebar__group": "囲いだけ",
};

/** `.tsx` を再帰で集める。 */
function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/**
 * ソースに現れる `pk-*` を集める。
 *
 * **埋め込み（`` `pk-card--${tone}` ``）は数えない。** 名前が実行時に
 * 決まるので、静的には照合できない。コメントも見ない（説明文の中の
 * 名前を実装の使用と取り違えないため）。
 */
function usedClasses(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of [...tsxFiles(join(SRC, "routes")), ...tsxFiles(join(SRC, "ui"))]) {
    // コメントを落とす。JSX の `{/* … */}` も含む（プロトタイプの
    // ファイル名がクラスに見えるのを避ける）。
    const code = readFileSync(path, "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const match of code.matchAll(/pk-[\w-]*/g)) {
      const name = match[0];
      // 直後が `${` なら、この語は名前の前半でしかない。
      if (code.startsWith("${", match.index + name.length)) continue;
      if (name in WITHOUT_RULE) continue;
      found.set(name, [...(found.get(name) ?? []), path.slice(SRC.length + 1)]);
    }
  }
  return found;
}

function undefinedClasses(prefix: string): string[] {
  return [...usedClasses()]
    .filter(([name]) => name.startsWith(prefix))
    .filter(([name]) => !new RegExp(`\\.${name}(?![\\w-])`).test(CSS))
    .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
}

describe("画面のクラスは CSS に定義がある", () => {
  it("`/m/*` が使う pk-m-* がすべて mobile.css / app.css に在る", () => {
    expect(undefinedClasses("pk-m-")).toEqual([]);
  });

  it("PC の画面と部品が使う pk-* がすべて app.css に在る", () => {
    expect(undefinedClasses("pk-").filter((entry) => !entry.startsWith("pk-m-"))).toEqual([]);
  });

  /**
   * `.pk-m-body { flex: 1 }` は `.pk-m` の**直接の子**でないと効かない。
   * 画面側が余分な箱で包むと静かに壊れるので、包まないことを固定する。
   */
  it("現場画面が head / body を余分な要素で包まない", () => {
    const offenders = readdirSync(MOBILE_ROUTES)
      .filter((name) => name.endsWith(".tsx") && name !== "layout.tsx")
      .filter((name) => {
        const source = readFileSync(join(MOBILE_ROUTES, name), "utf8");
        return /return \(\s*<(?:section|div|main)[^>]*>\s*<header className="pk-m-head"/.test(
          source,
        );
      });
    expect(offenders).toEqual([]);
  });
});

/**
 * CSS が構文として閉じていること。
 *
 * ── なぜここで見るのか ──────────────────────────────────
 * `pnpm check` は lint・typecheck・test の 3 つで、**`build` を含まない。**
 * ESLint は CSS を見ないので、**波かっこが 1 つ余っていても手元は全部緑**で
 * 通り、CI の `build`（lightningcss の minify）で初めて
 * `Unexpected end of input` として落ちる。実際に 1 度そうなった
 * （2026-08-22 / レイヤーの CSS を差し替えたとき）。
 *
 * 見るのは対応の数だけ。**整形も規則の中身も見ない**（それは stylelint の
 * 仕事で、導入は別の判断）。
 */
describe("CSS が閉じている", () => {
  /** コメントを落とす。**注記の中の記号を数えないため。** */
  function withoutComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  it.each(["app.css", "mobile.css"])("%s の波かっこが対応している", (file) => {
    const code = withoutComments(readFileSync(join(STYLES, file), "utf8"));
    let depth = 0;
    for (const ch of code) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      // 閉じ過ぎ（`}` が余る）はここで落ちる。最後まで見ずに止める。
      expect(depth, `${file}: 対応しない } がある`).toBeGreaterThanOrEqual(0);
    }
    expect(depth, `${file}: 閉じていない { がある`).toBe(0);
  });
});
