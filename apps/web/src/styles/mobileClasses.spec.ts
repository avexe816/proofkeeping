/**
 * 現場画面（`/m/*`）のクラスが CSS に在ることを固定する。
 *
 * ── なぜ機械で見るのか ──────────────────────────────────
 * 未定義のクラスは**エラーにならず、素の要素として描かれる。**
 * `report.tsx` だけが `pk-m-screen` で `head` と `body` を包んでいて、
 * `.pk-m`（flex の列）と `.pk-m-body { flex: 1 }` の親子が切れ、
 * 本文が縦に伸びなくなっていた。**typecheck も lint も通る種類の壊れ方**
 * なので、ここで押さえる。
 *
 * ── 見るのは「在るか」だけ ──────────────────────────────
 * 描画も見た目も見ない（sidebarLayout.spec.ts と同じ流儀）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const STYLES = import.meta.dirname;
const ROUTES = join(STYLES, "..", "routes", "m");

const CSS = ["mobile.css", "app.css"]
  .map((file) => readFileSync(join(STYLES, file), "utf8"))
  .join("\n");

/**
 * ソースに現れる `pk-m-*` を集める。
 *
 * **埋め込み（`` `pk-m-card--${tone}` ``）は数えない。** 名前が実行時に
 * 決まるので、静的には照合できない。コメントも見ない（説明文の中の
 * 名前を実装の使用と取り違えないため）。
 */
function usedMobileClasses(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(ROUTES).filter((name) => name.endsWith(".tsx"))) {
    const code = readFileSync(join(ROUTES, file), "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");
    for (const match of code.matchAll(/pk-m[\w-]*/g)) {
      const name = match[0];
      // 直後が `${` なら、この語は名前の前半でしかない。
      if (code.startsWith("${", match.index + name.length)) continue;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }
  return found;
}

describe("現場画面のクラスは CSS に定義がある", () => {
  it("`/m/*` が使う pk-m-* がすべて mobile.css / app.css に在る", () => {
    const undefinedClasses = [...usedMobileClasses()]
      .filter(([name]) => !new RegExp(`\\.${name}(?![\\w-])`).test(CSS))
      .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
    expect(undefinedClasses).toEqual([]);
  });

  /**
   * `.pk-m-body { flex: 1 }` は `.pk-m` の**直接の子**でないと効かない。
   * 画面側が余分な箱で包むと静かに壊れるので、包まないことを固定する。
   */
  it("画面が head / body を余分な要素で包まない", () => {
    const offenders = readdirSync(ROUTES)
      .filter((name) => name.endsWith(".tsx") && name !== "layout.tsx")
      .filter((name) => {
        const source = readFileSync(join(ROUTES, name), "utf8");
        return /return \(\s*<(?:section|div|main)[^>]*>\s*<header className="pk-m-head"/.test(
          source,
        );
      });
    expect(offenders).toEqual([]);
  });
});
