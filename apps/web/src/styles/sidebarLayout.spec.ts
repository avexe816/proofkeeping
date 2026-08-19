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
