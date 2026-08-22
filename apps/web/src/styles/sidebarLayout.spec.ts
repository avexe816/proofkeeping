/**
 * サイドバーの折りたたみ寸法（PK-SPEC-UI-A01 第2版 §1.1・§4.4 / P7-21）。
 *
 * task: docs/tasks/P7-21.md
 *
 * ── なぜ CSS を検査するのか ─────────────────────────────
 * 受け入れ基準 #13 は「ブランド幅とサイドバー幅が**両状態で**一致している」。
 * 実装は CSS カスタムプロパティの同時切替で担保しているので、
 * **その約束が消えていないこと**だけをここで固定する（printLayout.spec.ts と
 * 同じ流儀。描画の検査はしない）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "app.css"), "utf8");

describe("サイドバーの折りたたみ（A01 第2版 §4.4）", () => {
  it("展開時のブランド幅とサイドバー幅が同じ値（基準 #13）", () => {
    const sidebar = /--sidebarWidth:\s*(\d+)px/.exec(CSS);
    const brand = /--brandWidth:\s*(\d+)px/.exec(CSS);
    expect(sidebar).not.toBeNull();
    expect(brand).not.toBeNull();
    expect(sidebar?.[1]).toBe(brand?.[1]);
  });

  it("レール幅が 56px（A01 §1.1）", () => {
    expect(CSS).toMatch(/--sidebarWidthCollapsed:\s*56px/);
  });

  /**
   * **レール時も 2 つの幅が同時に切り替わる。** 片方だけ切り替えると
   * 縦のラインが崩れる（基準 #13 違反）。修飾子の中で両方が同じ
   * トークンを参照していることを見る。
   */
  it("レール修飾子がブランド幅とサイドバー幅を同時に切り替える", () => {
    const block = /\.pk-shell--nav-collapsed\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(block).toMatch(/--sidebarWidth:\s*var\(--sidebarWidthCollapsed\)/);
    expect(block).toMatch(/--brandWidth:\s*var\(--sidebarWidthCollapsed\)/);
  });

  /** レール時にラベル・注記が隠れ、`title` 頼みのアイコン表示になる。 */
  it("レール時にラベルと注記を隠す規則がある", () => {
    expect(CSS).toMatch(/\.pk-shell--nav-collapsed\s+\.pk-nav__label/);
    expect(CSS).toMatch(/\.pk-shell--nav-collapsed\s+\.pk-sidebar__scope/);
  });
});

/**
 * 畳む動き（人間の指示 2026-08-20「畳むのが遅い / なめらかにできないか」）。
 *
 * **速さの本体は CSS ではない**（レールの往復を止めたのは `layout.tsx`）。
 * ここで固定するのは、動きが CSS 側だけで完結していること
 * ＝ 2 つの幅が同じ時間で動き、動きを減らす設定に従うこと。
 */
describe("畳む動き", () => {
  function block(selector: string): string {
    return new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? "";
  }

  /** 幅が違う時間で動くと、動いている間だけ縦のラインが折れる（基準 #13）。 */
  it("サイドバー幅とブランド幅が同じ時間・同じ曲線で動く", () => {
    const sidebar = /transition:\s*width\s*([^;]+);/.exec(block("\\.pk-sidebar"))?.[1];
    const brand = /transition:\s*width\s*([^;]+);/.exec(block("\\.pk-topbar__brand"))?.[1];
    expect(sidebar).toBeDefined();
    expect(brand).toBe(sidebar);
  });

  /** セクションは高さを繋ぐ。**項目を DOM から外していない**ことの裏返し。 */
  it("セクションの開閉が grid-template-rows で動く", () => {
    expect(block("\\.pk-sidebar__items")).toMatch(/transition:\s*grid-template-rows/);
    expect(block("\\.pk-sidebar__group--closed\\s+\\.pk-sidebar__items")).toMatch(
      /grid-template-rows:\s*0fr/,
    );
  });

  it("動きを減らす設定で transition を切る", () => {
    const reduce = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1];
    expect(reduce).toBeDefined();
    expect(reduce).toMatch(/\.pk-sidebar\b/);
    expect(reduce).toMatch(/\.pk-sidebar__items/);
    expect(reduce).toMatch(/transition:\s*none/);
  });
});

/**
 * 設定の 2 カラムが**列ごとに**スクロールすること（人間の指示 2026-08-22
 * 「設定の SubMenu にも Scroll Bar を」「右の Content Area の上下は
 * その SubMenu に影響なし」）。
 *
 * ── なぜ CSS を検査するのか ─────────────────────────────
 * 独自スクロールは 3 つの宣言が揃って初めて成立する。**1 つ落ちると
 * 静かに元の「1 つのスクローラ」に戻る**（エラーにならず、
 * 見た目も広い画面で長い表を開くまで変わらない）。
 *
 *   `grid-template-rows: minmax(0, 1fr)`   行を中身の高さまで伸ばさない
 *   `min-height: 0`                        子が縮めるようにする
 *   `overflow-y: auto`（両列）              溢れる側を列が受け持つ
 *
 * 実際の高さの計算はブラウザで確認済み（`.pk-main` が伸びなくなり、
 * 左右がそれぞれ独自の `scrollTop` を持つこと）。ここは約束の維持だけを見る。
 */
describe("設定の 2 カラム（DECISIONS #258 / 人間の指示 2026-08-22）", () => {
  /** 作業領域が広いときのブロック（`@container workspace`）。 */
  function wideBlock(): string {
    const start = CSS.indexOf("@container workspace (min-width: 900px)");
    expect(start, "@container workspace が無い").toBeGreaterThan(-1);
    let depth = 0;
    for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      if (CSS[i] === "}") {
        depth--;
        if (depth === 0) return CSS.slice(start, i + 1);
      }
    }
    throw new Error("@container のブロックが閉じていない");
  }

  const block = wideBlock();

  /** ブロックの中の 1 規則。 */
  function rule(selector: string): string {
    return new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(block)?.[1] ?? "";
  }

  it("行を中身の高さまで伸ばさない（伸びるとスクロールバーが出ない）", () => {
    const settings = rule(".pk-settings");
    expect(settings).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(settings).toMatch(/min-height:\s*0/);
  });

  it("**設定内ナビが自前のスクロールを持つ**（左の全体ナビと同じ形）", () => {
    const nav = rule(".pk-settingsnav");
    expect(nav).toMatch(/overflow-y:\s*auto/);
    expect(nav).toMatch(/min-height:\s*0/);
  });

  it("**右の内容も自前のスクロールを持つ**（上下に動かしても左は動かない）", () => {
    const body = rule(".pk-settings__body");
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it("スクローラを `<details>` 自身に置く（`::details-content` で連鎖が切れる）", () => {
    // 中の `__body` に置くと、間に `::details-content` が挟まる実装で
    // 高さが伝わらず、ブラウザによってスクロールバーが出ない。
    expect(rule(".pk-settingsnav__body")).not.toMatch(/overflow-y:/);
  });

  it("**`position: sticky` に戻さない**（自前のスクロールと役割が重なる）", () => {
    expect(rule(".pk-settingsnav__body")).not.toMatch(/position:\s*sticky/);
  });

  it("狭いときは 1 カラムのまま（畳んだナビが独自スクロールを持たない）", () => {
    // `@container` の外側の `.pk-settingsnav__body` は畳んだ形のまま。
    const outside = CSS.replace(block, "");
    expect(outside).toMatch(/\.pk-settingsnav__body\s*\{/);
    const base = /\.pk-settingsnav__body\s*\{([^}]*)\}/.exec(outside)?.[1] ?? "";
    expect(base).not.toMatch(/overflow-y:/);
  });
});
