/**
 * 案内カードの印刷レイアウト（PK-SPEC-P7 §2.4 v1.1 / P7-02）。
 *
 * task: docs/tasks/P7-02.md
 *
 * ── なぜ CSS を検査するのか ─────────────────────────────
 * 完了条件は「**ブラウザの印刷機能で A4 に収まる**」。実際の紙に出るのは
 * ブラウザなので、ここで確かめられるのは**寸法の約束が消えていないこと**
 * だけ。だがそれで足りる: カードは項目が固定で、勝手に伸びる要素が無い。
 * 崩れるとすれば「`@page` を消した」「幅を広げた」「画面の枠を
 * 印刷対象に戻した」のいずれかで、**そのどれもがここで落ちる。**
 *
 * P7-15 の `docs/guides/*.html` は分量が伸びうるので、
 * `tests/docs/customerDocs.spec.ts` が文字数と手順数まで見ている。
 * **こちらは伸びる余地が無いぶん、寸法だけを固定する。**
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "app.css"), "utf8");

/** A4 の短辺（mm）。左右余白 12mm ずつを引いた内寸が上限。 */
const A4_WIDTH_MM = 210;
const PRINT_MARGIN_MM = 12;

/** `@media print { … }` の中身だけを取り出す。 */
function printBlock(): string {
  const start = CSS.indexOf("@media print");
  expect(start, "@media print が無い").toBeGreaterThan(-1);
  // 対応する閉じ括弧まで数える（中に @page などの入れ子がある）。
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error("@media print が閉じていない");
}

describe("案内カードの印刷（§2.4 v1.1）", () => {
  it("印刷の用紙が A4", () => {
    expect(printBlock()).toMatch(/@page\s*\{[^}]*size:\s*A4/);
  });

  /**
   * **カードの幅が A4 の内寸に収まる。**
   * ここを広げると横にはみ出し、2 枚目にこぼれる。
   */
  it("カードの幅が A4 の内寸を超えない", () => {
    const width = /\.pk-card\s*\{[^}]*max-width:\s*(\d+(?:\.\d+)?)mm/.exec(CSS);
    expect(width, ".pk-card に max-width が無い").not.toBeNull();
    expect(Number(width?.[1])).toBeLessThanOrEqual(A4_WIDTH_MM - PRINT_MARGIN_MM * 2);
  });

  /** **カードを途中で改ページさせない。** 2 枚に割れた案内は貼れない。 */
  it("カードが改ページで割れない", () => {
    expect(printBlock()).toMatch(/page-break-inside:\s*avoid/);
    expect(printBlock()).toMatch(/break-inside:\s*avoid/);
  });

  /**
   * **画面の枠と操作系を紙に出さない。**
   * topbar / sidebar / 登録フォームが混ざると 1 枚に収まらない。
   */
  it("印刷対象が .pk-print の中だけ", () => {
    const block = printBlock();
    expect(block).toMatch(/body\s*\*\s*\{[^}]*visibility:\s*hidden/);
    expect(block).toMatch(/\.pk-print\s*,\s*\.pk-print\s*\*\s*\{[^}]*visibility:\s*visible/);
    expect(block).toMatch(/\.pk-print__hide\s*\{[^}]*display:\s*none/);
  });

  /**
   * QR のクワイエットゾーン（周囲の余白）。**詰めると読み取り率が落ちる。**
   * 規格は 4 モジュールぶんを求める。ここでは印字サイズに対する余白で持つ。
   */
  it("QR に余白と白背景がある", () => {
    const qr = /\.pk-card__qr\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(qr).toMatch(/padding:\s*\d/);
    expect(qr).toMatch(/background:\s*#fff/);
  });
});
