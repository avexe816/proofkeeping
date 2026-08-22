/**
 * 客室タイプと目安時間の画面が守る境界（P1-24 / P1-02 / 人間の指示 2026-08-22）。
 *
 * task:   docs/tasks/P1-24.md / docs/tasks/P1-02.md
 * ルール: .claude/rules/security.md §1 / CLAUDE.md §4
 *
 * ── なぜソースを読むのか ────────────────────────────────
 * ここで確かめたいのは「**この経路が存在しないこと**」で、実行しても
 * 現れない（`staffScreen.spec.ts` と同じ作り）。2 画面を 1 枚にまとめた
 * ので、**門が混ざっていないこと**をとくに見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(import.meta.dirname, "roomTypes.tsx"), "utf8");
const REDIRECT = readFileSync(join(import.meta.dirname, "standardTimes.tsx"), "utf8");

/** コメントを落としたソース。「この語が無いこと」を見るときはこちら。 */
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

describe("客室タイプと目安時間の画面", () => {
  it("目安時間の門を客室タイプの門と混ぜていない（security.md §1）", () => {
    // `PROPERTY_MANAGER` は客室タイプを直せるが、目安時間は直せない。
    expect(SOURCE).toContain('assertPermission(tenant, "standardTime.write"');
    expect(SOURCE).toContain('assertPermission(tenant, "property.write"');
    // 目安時間の分岐は `property.write` の門より**手前**にある
    // （手前に無いと `PROPERTY_MANAGER` が目安時間を保存できてしまう）。
    const minutesGate = SOURCE.indexOf('assertPermission(tenant, "standardTime.write"');
    const propertyGate = SOURCE.indexOf('assertPermission(tenant, "property.write"');
    expect(minutesGate).toBeGreaterThan(0);
    expect(minutesGate).toBeLessThan(propertyGate);
  });

  it("読めない相手には目安時間を**引かない**（loader の戻り値に残さない）", () => {
    expect(SOURCE).toContain(
      "canReadMinutes ? listStandardTimes(env, tenant, property.id) : Promise.resolve([])",
    );
  });

  it("消す口が無い（CLAUDE.md §4）", () => {
    // `standardTime` と `checklistTemplate` がこの ID を参照している。
    expect(CODE).not.toContain("deleteRoomType");
    expect(CODE).not.toMatch(/value="delete"/);
  });

  it("コードを編集できない（CSV 取込と外部連携の鍵）", () => {
    // 編集フォームに `name="code"` の欄が無いこと（新規登録にだけある）。
    expect(SOURCE).toContain('<input id="new-code" name="code"');
    expect(SOURCE).not.toContain('<input id="edit-code"');
  });

  it("無効化は割当客室数を先に見せる（§24.5 MUST）", () => {
    expect(SOURCE).toContain("confirmDeactivate");
    expect(SOURCE).toContain('fieldOf(form, "confirm") !== "yes"');
  });

  it("保存に成功したらレイヤーを閉じる（POST → リダイレクト → GET）", () => {
    expect(SOURCE).toContain("function savedRedirect(");
    expect(CODE).not.toMatch(/return \{ created: true \}/);
    expect(CODE).not.toMatch(/return \{ updated: true \}/);
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

  it("旧 URL は客室タイプへ送るだけ（画面を 2 つ残さない）", () => {
    expect(REDIRECT).toContain('redirect("/app/settings/room-types", 301)');
    // 表も入力欄も残っていないこと。
    expect(REDIRECT).not.toContain("buildMatrix");
    expect(REDIRECT).not.toContain("<table");
  });
});
