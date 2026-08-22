/**
 * 設定内ナビ（左の Sub Tree Menu）が消えない条件（人間の指摘 2026-08-22
 * 「研修と資格をクリックすると、左の Sub Tree Menu がなくなった」）。
 *
 * ルール: DECISIONS #258（設定の 2 カラム）
 *
 * ── 何が起きていたのか ──────────────────────────────────
 * ツリーが出るかどうかは**画面ごとの判定ではない。** `isSettingsSubScreen()`
 * は `/app/training` も設定として扱っており（`ui/settingsNav.spec.ts`）、
 * サーバーは 16 項目を返している。**実機で確かめたところ、研修と資格でも
 * 他の設定画面とまったく同じ HTML が出る。**
 *
 * 消えるのは CSS の側で、条件は 2 つだけ。
 *
 *   1. 作業領域が閾値より狭い → 1 行の `⚙ 設定` に畳まる
 *   2. `::details-content` を持たない実装 → 列が空になる
 *
 * どちらも**設定のどの画面でも同じように起きる。** 研修と資格で気づいた
 * だけで、そこだけの不具合ではない。この 2 つをここで固定する。
 *
 * ── なぜ CSS を検査するのか ─────────────────────────────
 * 閾値もフォールバックも**消えても他のテストが落ちない。** 画面は出るし
 * 型も通る。狭い画面か古いブラウザでだけ列が空になり、気づくのは人間が
 * 見たときになる（`printLayout.spec.ts` と同じ理由）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "app.css"), "utf8");

/** 設定サイドバーの 2 カラムを作る `@container` の中身。 */
function workspaceBlock(): string {
  const at = CSS.indexOf("@container workspace");
  expect(at, "@container workspace が無い").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = CSS.indexOf("{", at); i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(at, i + 1);
    }
  }
  throw new Error("@container workspace が閉じていない");
}

/** 閾値（作業領域の幅）。 */
function threshold(): number {
  const match = /@container workspace \(min-width:\s*(\d+)px\)/.exec(CSS);
  expect(match, "閾値が読めない").not.toBeNull();
  return Number(match?.[1]);
}

describe("設定内ナビが消えない条件", () => {
  /**
   * 閾値は**作業領域**の幅で、viewport ではない（`.pk-main` の注記）。
   * 左のサイドバーが 214px あるので、必要な viewport は閾値 + 214px。
   *
   * 1366×768 のノートを 125% で使うと viewport は 1093px。ここに収まらないと
   * **設定のどの画面でもツリーが畳まる。** 画面の拡大は日本語の業務画面で
   * 普通の設定なので、そこは 2 カラムのままにする。
   */
  it("1366px のノートを 125% に拡大しても 2 カラムのまま", () => {
    const SIDEBAR_WIDTH = 214;
    const ZOOMED_VIEWPORT = Math.floor(1366 / 1.25); // 1092
    expect(threshold() + SIDEBAR_WIDTH).toBeLessThanOrEqual(ZOOMED_VIEWPORT);
  });

  /**
   * 下げすぎると今度は中身が潰れる。ナビ 208px を引いて 552px を残す。
   * **552px を切ると `.pk-form` の入力欄と KPI の 4 枚が同時に潰れる。**
   */
  it("中身に 552px 以上を残す（下げすぎない）", () => {
    const NAV_WIDTH = 208;
    expect(threshold() - NAV_WIDTH).toBeGreaterThanOrEqual(552);
  });

  /**
   * 2 カラムのとき `summary` は隠す。**隠したまま中身も隠れると列が空になる。**
   * `::details-content` を持つ実装と持たない実装の両方に手当てがあること。
   */
  it("`summary` を隠す側と、中身を見せる側が両方ある", () => {
    const block = workspaceBlock();
    expect(block).toContain(".pk-settingsnav__toggle");
    expect(block).toMatch(/\.pk-settingsnav__toggle\s*\{\s*display:\s*none/);

    // 新しい実装。
    expect(block).toContain(".pk-settingsnav::details-content");
    // `::details-content` を持たない実装のための保険。**これを消さないこと。**
    expect(block).toMatch(/\.pk-settingsnav:not\(\[open\]\)\s*>\s*\.pk-settingsnav__body/);
  });

  /** 2 カラムそのもの。列が 1 本に戻ると、そもそもツリーの置き場が無い。 */
  it("2 カラムの列指定が残っている", () => {
    expect(workspaceBlock()).toMatch(/grid-template-columns:\s*208px\s+minmax\(0,\s*1fr\)/);
  });
});
