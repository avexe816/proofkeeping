/**
 * 取引先と料金の画面が守る境界（P5-02 / P5-03 / 人間の指示 2026-08-22）。
 *
 * task:   docs/tasks/P5-02.md / docs/tasks/P5-03.md
 * ルール: .claude/rules/billing.md §1・§6 / CLAUDE.md §4
 *
 * ── なぜソースを読むのか ────────────────────────────────
 * ここで確かめたいのは「**この経路が存在しないこと**」で、実行しても
 * 現れない。消す口を足した瞬間に落ちる形にするには、画面のソースを
 * 走査するのがいちばん確実（`staffScreen.spec.ts` と同じ作り）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ja } from "../../locales/index.js";

const SOURCE = readFileSync(join(import.meta.dirname, "counterparties.tsx"), "utf8");

/**
 * コメントを落としたソース。
 *
 * **禁止事項を説明した doc コメント自体が検査に引っ掛かる**ので、
 * 「この語が無いこと」を見るときはこちらを使う。
 */
const CODE = SOURCE.split("\n")
  .filter((line) => {
    const trimmed = line.trimStart();
    return (
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("/*") &&
      !trimmed.startsWith("{/*")
    );
  })
  .join("\n");

describe("取引先と料金の画面", () => {
  it("消す口が無い（CLAUDE.md §4）", () => {
    // 取引先は `isActive = false`、料金は `validTo`。**どちらも行は残る。**
    expect(CODE).not.toMatch(/deleteCounterparty|deletePricingRule/);
    expect(CODE).not.toMatch(/value="delete/);
  });

  it("料金を書き換える口が無い（billing.md §6）", () => {
    // 単価を書き換えると、その料金で出した過去の請求書の根拠が消える。
    // 変えるときは終了日を入れて新しい行を足す。
    expect(CODE).not.toContain("updatePricingRule");
    expect(CODE).not.toMatch(/value="updatePricing/);
  });

  it("レイヤーは書ける相手にだけ開く", () => {
    // `resolvePanel()` が `canWrite` で閉じる。中身は登録・編集・終了の
    // 口しか無く、`AUDITOR` に押せないフォームを見せない。
    expect(SOURCE).toContain('if (param === null || param === "" || !data.canWrite) return null;');
  });

  it("保存に成功したらレイヤーを閉じる（POST → リダイレクト → GET）", () => {
    // `useActionData` に成功を残すと、戻るボタンで開いたままの状態に戻る。
    expect(SOURCE).toContain("function savedRedirect(");
    // 成功を表す真偽値を `action` から返していないこと。
    expect(CODE).not.toMatch(/return \{ saved: true \}/);
    expect(CODE).not.toMatch(/return \{ closed: true \}/);
  });

  it("取引の終了を編集フォームに混ぜていない", () => {
    // 「保存」を押したつもりで取引が終わる形にしない。
    expect(SOURCE).toContain('<input type="hidden" name="intent" value="counterpartyActive" />');
    // 編集は `counterpartyFields(form)` だけを読む（`isActive` を含めない）。
    expect(SOURCE).toContain("counterpartyUpdateSchema.safeParse(counterpartyFields(form))");
  });

  it("スタッフ管理と同じ CSS を使う（この画面のためのクラスを足さない）", () => {
    for (const className of [
      "pk-pagehead__actions",
      "pk-page__lede",
      "pk-panel__body--flush",
      "pk-tbl",
      "pk-drawer__panel",
      "pk-drawer__section--danger",
    ]) {
      expect(SOURCE, className).toContain(className);
    }
    // 独立した表（`pk-grid`）はカードの中で使わない（app.css の注記）。
    expect(CODE).not.toContain("pk-grid");
  });

  it("料金は書き換えないことを画面の文言で伝える", () => {
    expect(SOURCE).toContain("cp.pricing.immutable");
    expect(ja["cp.pricing.immutable"]).toContain("終了日");
  });
});
