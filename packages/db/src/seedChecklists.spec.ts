/**
 * 既定のチェックリストテンプレート（PK-SPEC-P1 §6.2）。
 *
 * task: docs/tasks/P1-06.md
 *
 * **仕様の表と 1 対 1 であることを固定する。** 良かれと思って項目を足すと
 * §7 のリスク表が言う形骸化に向かうため、件数と写真必須の位置を数える。
 */

import { describe, expect, it } from "vitest";

import { SEED_CHECKLIST_TEMPLATES } from "./seedChecklists.js";

describe("既定テンプレート", () => {
  it("2 種ある（アウト清掃・滞在清掃）", () => {
    expect(SEED_CHECKLIST_TEMPLATES.map((template) => template.taskType)).toEqual([
      "CHECKOUT",
      "STAYOVER",
    ]);
  });

  it("アウト清掃は §6.2 の 17 項目", () => {
    const checkout = SEED_CHECKLIST_TEMPLATES.find((t) => t.taskType === "CHECKOUT");

    expect(checkout?.items).toHaveLength(17);
    expect([...new Set(checkout?.items.map((item) => item.section))]).toEqual([
      "ベッドまわり",
      "浴室",
      "客室",
      "アメニティ・備品",
      "最終確認",
    ]);
  });

  it("滞在清掃は §6.2 の 8 項目", () => {
    const stayover = SEED_CHECKLIST_TEMPLATES.find((t) => t.taskType === "STAYOVER");

    expect(stayover?.items).toHaveLength(8);
  });

  it("写真必須はアウト清掃 3 件・滞在清掃 1 件（§6.2 の 📷）", () => {
    const counts = SEED_CHECKLIST_TEMPLATES.map(
      (template) => template.items.filter((item) => item.photoRequired).length,
    );

    expect(counts).toEqual([3, 1]);
  });

  it("全項目に日本語と英語がある（§12.2 / INV-35）", () => {
    for (const template of SEED_CHECKLIST_TEMPLATES) {
      for (const item of template.items) {
        expect(item.labels.ja.length, item.labels.ja).toBeGreaterThan(0);
        expect(item.labels.en.length, item.labels.ja).toBeGreaterThan(0);
      }
    }
  });

  it("任意項目は §6.2 が「任意」と書いた 2 件だけ", () => {
    const optional = SEED_CHECKLIST_TEMPLATES.flatMap((template) =>
      template.items.filter((item) => !item.isRequired).map((item) => item.labels.ja),
    );

    expect(optional).toEqual(["窓・鏡を清掃した", "シーツを交換した（3泊目のみ）"]);
  });

  it("写真必須の項目が任意になっていない", () => {
    // 任意かつ写真必須は、記録しなければ写真も要らないという抜け道になる。
    for (const template of SEED_CHECKLIST_TEMPLATES) {
      for (const item of template.items) {
        if (item.photoRequired) expect(item.isRequired, item.labels.ja).toBe(true);
      }
    }
  });
});
